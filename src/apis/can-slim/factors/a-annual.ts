// A 因子：年度盈利（Annual Earnings）
//
// C 看的是「最近一个季度够不够猛」，A 看的是「这家公司长期是不是真的在成长」。
// 只有 C 没有 A，很可能是周期股的短期反弹或低基数效应；两者兼备才是 O'Neil 要找的成长股。
//
// 三个维度（对应规格第 3 节）：
// 1. 3 年 EPS 复合增长率（CAGR）
// 2. 年度净利润是否连续增长
// 3. ROE 水平（优先 roe_dt，即扣除非经常损益后的净资产收益率）
//
// 为什么 ROE 用扣非口径：一次性的资产处置、政府补助、公允价值变动都会推高普通 ROE，
// 但它们不代表主营业务的赚钱能力。CAN SLIM 关心的是可持续的盈利质量。
//
// 亏损与负基数处理：CAGR 公式在起始值 ≤ 0 时无意义（负数开根号）。
// 这类公司单独归类为「由亏转盈」或「持续亏损」，不套用 CAGR。

import type { FinaIndicatorRow } from "../data-source";
import type { CanSlimConfig } from "../config";
import type { FactorResult } from "../types";
import { degraded } from "../types";

/** 年度增长的定性分类 */
type AnnualGrowthKind =
  | "cagr" // 可正常计算复合增长
  | "turnaround" // 起始年亏损、最新年盈利
  | "deteriorate" // 起始年盈利、最新年亏损
  | "loss" // 持续亏损
  | "insufficient"; // 年报数量不足

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 判断是否为年报（报告期为 12 月 31 日） */
function isAnnual(endDate: string): boolean {
  return endDate.endsWith("1231");
}

/**
 * 分段线性映射增长率到分值。
 * 与 C 因子同构：负增长快速衰减，门槛线给 60% 分值，优秀线给满分。
 */
function mapGrowth(
  growth: number | null,
  threshold: number,
  excellent: number,
  maxScore: number
): number {
  if (growth === null) return 0;
  if (growth <= -20) return 0;
  if (growth < 0) return clamp(((growth + 20) / 20) * maxScore * 0.2, 0, maxScore);
  if (growth < threshold) {
    return clamp(maxScore * 0.2 + (growth / threshold) * maxScore * 0.4, 0, maxScore);
  }
  if (growth < excellent) {
    return clamp(
      maxScore * 0.6 + ((growth - threshold) / (excellent - threshold)) * maxScore * 0.4,
      0,
      maxScore
    );
  }
  return maxScore;
}

/**
 * 计算 EPS 复合增长率。
 *
 * @param annuals 年报序列，按 end_date 降序
 * @param years 跨越年数
 */
function computeEpsCagr(
  annuals: FinaIndicatorRow[],
  years: number
): { cagr: number | null; kind: AnnualGrowthKind; latest: number | null; base: number | null } {
  // 需要 years + 1 个年报才能算 years 年的复合增长（首尾各一个）
  if (annuals.length < years + 1) {
    return { cagr: null, kind: "insufficient", latest: null, base: null };
  }

  const latestRow = annuals[0]!;
  const baseRow = annuals[years]!;
  // EPS 优先用基本每股收益；缺失时退回稀释每股收益
  const latest = latestRow.eps ?? latestRow.dt_eps;
  const base = baseRow.eps ?? baseRow.dt_eps;

  if (latest === null || base === null) {
    return { cagr: null, kind: "insufficient", latest, base };
  }
  if (base <= 0 && latest > 0) {
    return { cagr: null, kind: "turnaround", latest, base };
  }
  if (base > 0 && latest <= 0) {
    return { cagr: null, kind: "deteriorate", latest, base };
  }
  if (base <= 0 && latest <= 0) {
    return { cagr: null, kind: "loss", latest, base };
  }

  const cagr = (Math.pow(latest / base, 1 / years) - 1) * 100;
  return { cagr, kind: "cagr", latest, base };
}

/**
 * 判断年度净利润是否连续增长。
 * 用扣非净利润（profit_dedt）判断，理由同 ROE 用扣非口径。
 */
function judgeConsecutiveGrowth(
  annuals: FinaIndicatorRow[],
  years: number
): { consecutive: boolean; series: { year: string; profit: number }[] } {
  const series = annuals
    .slice(0, years + 1)
    .filter((a) => a.profit_dedt !== null)
    .map((a) => ({ year: a.end_date.slice(0, 4), profit: a.profit_dedt as number }));

  if (series.length < 2) return { consecutive: false, series };

  // series 降序（最新在前），连续增长意味着 series[i] > series[i+1]
  let consecutive = true;
  for (let i = 0; i < series.length - 1; i++) {
    if (series[i]!.profit <= series[i + 1]!.profit) {
      consecutive = false;
      break;
    }
  }
  return { consecutive, series };
}

/**
 * 计算 A 因子。
 *
 * @param periods 基准日之前可见的全部报告期（含季报），按 end_date 降序
 * @param cfg 生效配置
 */
export function computeAnnualEarningsFactor(
  periods: FinaIndicatorRow[],
  cfg: CanSlimConfig
): FactorResult {
  const annuals = periods.filter((p) => isAnnual(p.end_date));

  if (annuals.length === 0) {
    return degraded("无可用年报数据");
  }

  const { epsCagrMin, epsCagrStrong, roeMin, roeStrong, cagrYears } = cfg.a;

  // 年报不足时降级而非硬算：用 1~2 年数据算「3 年复合增长」会得出误导性结论
  if (annuals.length < cagrYears + 1) {
    return degraded(
      `仅有 ${annuals.length} 个年报（需 ${cagrYears + 1} 个才能计算 ${cagrYears} 年复合增长），上市时间过短`
    );
  }

  const cagrResult = computeEpsCagr(annuals, cagrYears);
  const growth = judgeConsecutiveGrowth(annuals, cagrYears);

  // ROE：优先扣非口径，其次加权平均，最后普通 ROE
  const latestAnnual = annuals[0]!;
  const roe = latestAnnual.roe_dt ?? latestAnnual.roe_waa ?? latestAnnual.roe;

  // ===== 子项评分（沿用规格的 30 / 20 / 15 结构，放大到 0–100 尺度） =====
  let cagrScore = 0;
  if (cagrResult.kind === "cagr") {
    cagrScore = mapGrowth(cagrResult.cagr, epsCagrStrong, epsCagrStrong * 2, 35);
  } else if (cagrResult.kind === "turnaround") {
    // 由亏转盈：给中等偏上分值。是积极信号，但缺乏「持续成长」的证据
    cagrScore = 22;
  } else if (cagrResult.kind === "deteriorate") {
    cagrScore = 0;
  } else if (cagrResult.kind === "loss") {
    cagrScore = 0;
  }

  const consecutiveScore = growth.consecutive ? 25 : 0;

  let roeScore = 0;
  if (roe !== null) {
    if (roe >= roeStrong) {
      // 17% 以上按超出幅度继续加分，30% 封顶
      roeScore = clamp(24 + ((roe - roeStrong) / roeStrong) * 12, 24, 30);
    } else if (roe >= roeMin) {
      roeScore = 18 + ((roe - roeMin) / (roeStrong - roeMin)) * 6;
    } else if (roe > 0) {
      roeScore = clamp((roe / roeMin) * 18, 0, 18);
    }
  }

  let score = 10 + cagrScore + consecutiveScore + roeScore;

  // ===== 惩罚项 =====
  const penalties: string[] = [];
  // 最近年度利润下降：规格要求 -30
  if (growth.series.length >= 2) {
    const newest = growth.series[0]!;
    const prior = growth.series[1]!;
    if (newest.profit < prior.profit) {
      score -= 30;
      const dropPct =
        prior.profit !== 0 ? ((newest.profit - prior.profit) / Math.abs(prior.profit)) * 100 : 0;
      penalties.push(`最近年度扣非净利同比下降 ${Math.abs(dropPct).toFixed(1)}%`);
    }
  }
  if (cagrResult.kind === "deteriorate") {
    score -= 20;
    penalties.push("最新年度由盈转亏");
  }
  if (cagrResult.kind === "loss") {
    score -= 15;
    penalties.push("连续年度亏损");
  }
  // 高负债会放大成长的脆弱性，做小幅扣分
  const debtRatio = latestAnnual.debt_to_assets;
  if (debtRatio !== null && debtRatio > 70) {
    score -= 5;
    penalties.push(`资产负债率 ${debtRatio.toFixed(1)}%，偏高`);
  }

  score = clamp(score, 0, 100);

  // ===== 可解释明细 =====
  const details: string[] = [];
  const latestYear = latestAnnual.end_date.slice(0, 4);

  if (cagrResult.kind === "cagr" && cagrResult.cagr !== null) {
    details.push(
      `${cagrYears} 年 EPS 复合增长 ${cagrResult.cagr >= 0 ? "+" : ""}${cagrResult.cagr.toFixed(1)}%` +
        `（${annuals[cagrYears]!.end_date.slice(0, 4)} 年 ${cagrResult.base?.toFixed(2)} 元 → ${latestYear} 年 ${cagrResult.latest?.toFixed(2)} 元）` +
        (cagrResult.cagr >= epsCagrStrong
          ? "，达到优秀线"
          : cagrResult.cagr >= epsCagrMin
            ? "，达到合格线"
            : "，低于合格线")
    );
  } else if (cagrResult.kind === "turnaround") {
    details.push(
      `EPS 由亏转盈（${annuals[cagrYears]!.end_date.slice(0, 4)} 年 ${cagrResult.base?.toFixed(2)} 元 → ${latestYear} 年 ${cagrResult.latest?.toFixed(2)} 元），无法计算复合增长率`
    );
  } else if (cagrResult.kind === "deteriorate") {
    details.push(`EPS 由盈转亏（${latestYear} 年 ${cagrResult.latest?.toFixed(2)} 元）`);
  } else if (cagrResult.kind === "loss") {
    details.push("连续年度 EPS 为负，处于持续亏损状态");
  }

  if (growth.consecutive) {
    const trend = growth.series
      .slice()
      .reverse()
      .map((s) => `${s.year} 年 ${fmtMoney(s.profit)}`)
      .join(" → ");
    details.push(`年度扣非净利连续增长：${trend}`);
  } else if (growth.series.length >= 2) {
    const trend = growth.series
      .slice()
      .reverse()
      .map((s) => `${s.year} 年 ${fmtMoney(s.profit)}`)
      .join(" → ");
    details.push(`年度扣非净利未连续增长：${trend}`);
  }

  if (roe !== null) {
    const label =
      roe >= roeStrong
        ? `达到 O'Neil 标准（≥ ${roeStrong}%）`
        : roe >= roeMin
          ? `达到合格线（≥ ${roeMin}%）`
          : `低于合格线（< ${roeMin}%）`;
    details.push(`${latestYear} 年 ROE（扣非）${roe.toFixed(1)}%，${label}`);
  } else {
    details.push("ROE 数据缺失");
  }

  if (penalties.length > 0) {
    details.push(`⚠️ 扣分项：${penalties.join("；")}`);
  }

  return {
    score,
    details,
    metrics: {
      latestAnnualPeriod: latestAnnual.end_date,
      epsCagr: cagrResult.cagr === null ? null : Math.round(cagrResult.cagr * 100) / 100,
      epsCagrKind: cagrResult.kind,
      epsLatest: cagrResult.latest,
      epsBase: cagrResult.base,
      consecutiveGrowth: growth.consecutive ? 1 : 0,
      roe: roe === null ? null : Math.round(roe * 100) / 100,
      debtToAssets: debtRatio === null ? null : Math.round(debtRatio * 100) / 100,
      annualCount: annuals.length,
      cagrScore: Math.round(cagrScore * 10) / 10,
      consecutiveScore,
      roeScore: Math.round(roeScore * 10) / 10,
    },
  };
}

/**
 * A 因子硬门槛：3 年 EPS 复合增长达标，或处于由亏转盈状态。
 * 由盈转亏、持续亏损直接否决。
 */
export function passAnnualEarningsGate(
  result: FactorResult | undefined,
  cfg: CanSlimConfig
): boolean {
  if (!result || result.score === null) return false;
  const m = result.metrics;
  if (!m) return false;

  const kind = m.epsCagrKind;
  if (kind === "deteriorate" || kind === "loss") return false;
  if (kind === "turnaround") return true;

  const cagr = typeof m.epsCagr === "number" ? m.epsCagr : null;
  return cagr !== null && cagr >= cfg.a.epsCagrMin;
}

/** 金额（元）转为可读形式 */
function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`;
  return `${v.toFixed(0)} 元`;
}
