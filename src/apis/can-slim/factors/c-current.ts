// C 因子：当季盈利（Current Quarterly Earnings）
//
// O'Neil 的标准：最近季度 EPS 同比增长 ≥ 25%，营收同步走强，且增长处于加速状态。
// 「加速」比「高增长」更重要——连续几个季度增速抬升，往往对应基本面拐点，
// 而单季高增长可能只是低基数或一次性损益。
//
// 数据口径（字段名与行为均已实测确认）：
// - 单季同比优先用 fina_indicator 的 q_* 字段：q_netprofit_yoy（单季归母净利同比）、
//   q_sales_yoy（单季营收同比）、q_eps（单季 EPS）、q_dtprofit（单季扣非净利金额）
// - 累计同比作为补充与兜底：basic_eps_yoy、dt_netprofit_yoy、or_yoy
// - 单季扣非净利同比接口不直接提供，用相邻年度同期的 q_dtprofit 自行计算
//
// 无未来函数：报告期序列由 financials.ts 按 ann_date <= 基准日过滤后传入，
// 本模块只做纯计算，不接触数据库与接口。
//
// 亏损处理：由亏转盈、由盈转亏、接近盈亏平衡这三种情形不能套用普通同比百分比
// （分母为负或接近 0 时百分比失去意义），单独归类给分。

import type { FinaIndicatorRow } from "../data-source";
import type { CanSlimConfig } from "../config";
import type { FactorResult } from "../types";
import { degraded } from "../types";

/** 盈利状态转换类型 */
type ProfitTransition =
  | "normal" // 两期均为正，可正常计算同比
  | "turnaround" // 由亏转盈
  | "deteriorate" // 由盈转亏
  | "loss" // 两期均亏损
  | "unknown";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 分段线性映射：把增长率映射到 0 ~ maxScore。
 *
 * 设计成三段而不是直接线性：
 * - 负增长区间给低分并快速衰减（CAN SLIM 明确排斥利润下滑）
 * - 0 ~ 门槛线之间线性上升到 60% 分值
 * - 门槛线 ~ 优秀线之间上升到满分，超过优秀线不再加分（避免异常值主导）
 */
function mapGrowth(
  growth: number | null,
  threshold: number,
  excellent: number,
  maxScore: number
): number {
  if (growth === null) return 0;
  if (growth <= -20) return 0;
  if (growth < 0) {
    // -20% ~ 0% 映射到 0 ~ 20% 分值
    return clamp(((growth + 20) / 20) * maxScore * 0.2, 0, maxScore);
  }
  if (growth < threshold) {
    // 0 ~ 门槛 映射到 20% ~ 60% 分值
    return clamp(maxScore * 0.2 + (growth / threshold) * maxScore * 0.4, 0, maxScore);
  }
  if (growth < excellent) {
    // 门槛 ~ 优秀 映射到 60% ~ 100% 分值
    return clamp(
      maxScore * 0.6 + ((growth - threshold) / (excellent - threshold)) * maxScore * 0.4,
      0,
      maxScore
    );
  }
  return maxScore;
}

/** 判断两期利润的转换类型 */
function judgeTransition(current: number | null, previous: number | null): ProfitTransition {
  if (current === null || previous === null) return "unknown";
  if (previous <= 0 && current > 0) return "turnaround";
  if (previous > 0 && current <= 0) return "deteriorate";
  if (previous <= 0 && current <= 0) return "loss";
  return "normal";
}

/**
 * 从报告期序列中计算单季扣非净利同比。
 *
 * 接口只给单季扣非净利的金额（q_dtprofit），不给同比，需要自己找去年同期。
 * 「去年同期」= 报告期月日相同、年份减一的那条记录。
 */
function computeQuarterlyDtProfitYoy(
  periods: FinaIndicatorRow[],
  current: FinaIndicatorRow
): { yoy: number | null; transition: ProfitTransition; lastYearValue: number | null } {
  const currentYear = Number(current.end_date.slice(0, 4));
  const monthDay = current.end_date.slice(4);
  const lastYearEnd = `${currentYear - 1}${monthDay}`;
  const lastYear = periods.find((p) => p.end_date === lastYearEnd);

  const cur = current.q_dtprofit;
  const prev = lastYear?.q_dtprofit ?? null;
  const transition = judgeTransition(cur, prev);

  if (cur === null || prev === null) {
    return { yoy: null, transition: "unknown", lastYearValue: prev };
  }
  if (transition !== "normal") {
    return { yoy: null, transition, lastYearValue: prev };
  }
  return { yoy: ((cur - prev) / Math.abs(prev)) * 100, transition, lastYearValue: prev };
}

/**
 * 判定增长是否处于加速状态。
 *
 * 取最近若干个季度的单季净利同比，检查是否逐季抬升。
 * 只有连续 accelerationQuarters 个季度递增才算加速。
 */
function judgeAcceleration(
  periods: FinaIndicatorRow[],
  cfg: CanSlimConfig
): { accelerating: boolean; series: { endDate: string; yoy: number }[] } {
  // 取有单季净利同比的报告期（已按 end_date 降序）
  const series = periods
    .filter((p) => p.q_netprofit_yoy !== null)
    .slice(0, cfg.c.accelerationQuarters + 1)
    .map((p) => ({ endDate: p.end_date, yoy: p.q_netprofit_yoy as number }));

  if (series.length < cfg.c.accelerationQuarters + 1) {
    return { accelerating: false, series };
  }

  // series 是降序（最新在前），加速意味着 series[0] > series[1] > ...
  let accelerating = true;
  for (let i = 0; i < cfg.c.accelerationQuarters; i++) {
    const newer = series[i]!.yoy;
    const older = series[i + 1]!.yoy;
    if (newer <= older) {
      accelerating = false;
      break;
    }
  }
  return { accelerating, series };
}

/**
 * 计算 C 因子。
 *
 * @param periods 该股在基准日之前可见的财务报告期，按 end_date 降序
 * @param cfg 生效配置
 */
export function computeCurrentEarningsFactor(
  periods: FinaIndicatorRow[],
  cfg: CanSlimConfig
): FactorResult {
  if (periods.length === 0) {
    return degraded("无可用财务数据（可能尚未披露或接口未取到）");
  }

  const latest = periods[0]!;
  const {
    quarterlyProfitYoyMin,
    quarterlySalesYoyMin,
    epsYoyStrong,
    profitYoyStrong,
    salesYoyStrong,
  } = cfg.c;

  // ===== 各项增长指标 =====
  // 单季归母净利同比（核心指标）
  const qProfitYoy = latest.q_netprofit_yoy;
  // 单季营收同比
  const qSalesYoy = latest.q_sales_yoy;
  // 单季扣非净利同比（自行计算）
  const dtProfit = computeQuarterlyDtProfitYoy(periods, latest);
  // 累计口径作为补充
  const cumEpsYoy = latest.basic_eps_yoy;
  const cumDtProfitYoy = latest.dt_netprofit_yoy;

  // ===== 子项评分（分值上限沿用规格的 30 / 25 / 15 / 20 结构） =====
  // EPS：优先用单季净利同比作为 EPS 增长的代理（单季 EPS 同比接口未直接提供），
  // 缺失时退回累计 EPS 同比
  const epsGrowth = qProfitYoy ?? cumEpsYoy;
  const epsScore = mapGrowth(epsGrowth, epsYoyStrong, epsYoyStrong * 2, 30);

  // 扣非净利：优先单季自算同比，缺失时退回累计扣非同比
  const dtGrowth = dtProfit.yoy ?? cumDtProfitYoy;
  const dtScore = mapGrowth(dtGrowth, profitYoyStrong, profitYoyStrong * 2, 25);

  // 营收
  const salesScore = mapGrowth(qSalesYoy ?? latest.or_yoy, salesYoyStrong, salesYoyStrong * 2, 15);

  // 加速
  const accel = judgeAcceleration(periods, cfg);
  const accelScore = accel.accelerating ? 20 : 0;

  // 基准分：给 10 分底座，让「数据齐全但增长平平」与「数据缺失」区分开
  let score = 10 + epsScore + dtScore + salesScore + accelScore;

  // ===== 惩罚项 =====
  const details: string[] = [];
  const penalties: string[] = [];

  // 利润同比下滑：规格要求 -30
  if (epsGrowth !== null && epsGrowth < 0) {
    score -= 30;
    penalties.push(`单季净利同比下滑 ${epsGrowth.toFixed(1)}%`);
  }
  // 由盈转亏是更严重的信号
  if (dtProfit.transition === "deteriorate") {
    score -= 20;
    penalties.push("扣非净利由盈转亏");
  }
  if (dtProfit.transition === "loss") {
    score -= 15;
    penalties.push("扣非净利连续两年同期亏损");
  }

  score = clamp(score, 0, 100);

  // ===== 可解释明细 =====
  details.push(`最新报告期 ${formatPeriod(latest.end_date)}（公告日 ${latest.ann_date}）`);

  if (qProfitYoy !== null) {
    details.push(`单季归母净利同比 ${fmtPct(qProfitYoy)}`);
  } else if (cumEpsYoy !== null) {
    details.push(`累计 EPS 同比 ${fmtPct(cumEpsYoy)}（单季数据缺失）`);
  }

  if (dtProfit.yoy !== null) {
    details.push(`单季扣非净利同比 ${fmtPct(dtProfit.yoy)}`);
  } else if (dtProfit.transition === "turnaround") {
    details.push(
      `单季扣非净利由亏转盈（去年同期 ${fmtMoney(dtProfit.lastYearValue)} → 本期 ${fmtMoney(latest.q_dtprofit)}）`
    );
  } else if (dtProfit.transition === "deteriorate") {
    details.push(
      `单季扣非净利由盈转亏（去年同期 ${fmtMoney(dtProfit.lastYearValue)} → 本期 ${fmtMoney(latest.q_dtprofit)}）`
    );
  } else if (cumDtProfitYoy !== null) {
    details.push(`累计扣非净利同比 ${fmtPct(cumDtProfitYoy)}（单季数据缺失）`);
  }

  if (qSalesYoy !== null) {
    details.push(`单季营收同比 ${fmtPct(qSalesYoy)}`);
  } else if (latest.or_yoy !== null) {
    details.push(`累计营收同比 ${fmtPct(latest.or_yoy)}（单季数据缺失）`);
  }

  if (accel.accelerating) {
    const trend = accel.series
      .slice()
      .reverse()
      .map((s) => `${formatPeriod(s.endDate)} ${fmtPct(s.yoy)}`)
      .join(" → ");
    details.push(`净利增速连续 ${cfg.c.accelerationQuarters} 个季度加速：${trend}`);
  } else if (accel.series.length >= 2) {
    const trend = accel.series
      .slice()
      .reverse()
      .map((s) => `${formatPeriod(s.endDate)} ${fmtPct(s.yoy)}`)
      .join(" → ");
    details.push(`净利增速未构成连续加速：${trend}`);
  }

  if (penalties.length > 0) {
    details.push(`⚠️ 扣分项：${penalties.join("；")}`);
  }

  return {
    score,
    details,
    metrics: {
      latestPeriod: latest.end_date,
      annDate: latest.ann_date,
      qNetprofitYoy: round2(qProfitYoy),
      qSalesYoy: round2(qSalesYoy),
      qDtProfitYoy: round2(dtProfit.yoy),
      dtProfitTransition: dtProfit.transition,
      cumEpsYoy: round2(cumEpsYoy),
      cumDtNetprofitYoy: round2(cumDtProfitYoy),
      accelerating: accel.accelerating ? 1 : 0,
      epsScore: round2(epsScore),
      dtScore: round2(dtScore),
      salesScore: round2(salesScore),
      accelScore,
      periodsAvailable: periods.length,
    },
  };
}

/**
 * C 因子硬门槛：单季扣非净利同比与单季营收同比双达标。
 *
 * 由亏转盈视为通过——这类公司往往正处于 CAN SLIM 最看重的基本面拐点，
 * 用百分比阈值会把它们误杀（分母为负导致同比无意义）。
 */
export function passCurrentEarningsGate(
  result: FactorResult | undefined,
  cfg: CanSlimConfig
): boolean {
  if (!result || result.score === null) return false;
  const m = result.metrics;
  if (!m) return false;

  const transition = m.dtProfitTransition;
  const profitYoy =
    typeof m.qDtProfitYoy === "number"
      ? m.qDtProfitYoy
      : typeof m.cumDtNetprofitYoy === "number"
        ? m.cumDtNetprofitYoy
        : null;
  const salesYoy =
    typeof m.qSalesYoy === "number"
      ? m.qSalesYoy
      : null;

  // 由盈转亏或连续亏损：直接不通过
  if (transition === "deteriorate" || transition === "loss") return false;

  const profitOk = transition === "turnaround" || (profitYoy !== null && profitYoy >= cfg.c.quarterlyProfitYoyMin);
  // 营收数据缺失时不因此否决（部分行业单季营收口径缺失较常见），只要利润达标即可
  const salesOk = salesYoy === null || salesYoy >= cfg.c.quarterlySalesYoyMin;

  return profitOk && salesOk;
}

// ===== 格式化工具 =====

/** 20260630 → 2026Q2 */
function formatPeriod(endDate: string): string {
  const y = endDate.slice(0, 4);
  const md = endDate.slice(4);
  const q = md === "0331" ? "Q1" : md === "0630" ? "Q2" : md === "0930" ? "Q3" : md === "1231" ? "Q4" : md;
  return `${y}${q}`;
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** 金额（元）转为亿元/万元可读形式 */
function fmtMoney(v: number | null): string {
  if (v === null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`;
  return `${v.toFixed(0)} 元`;
}

function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}
