// L 因子：领导地位（Leader or Laggard）
//
// O'Neil 的原话是买行业龙头、市场强势股，而不是便宜的落后股。
// 关键在于「不能用绝对涨幅」——必须是个股收益率在全市场中的相对位置。
//
// 实现方式（对应规格第 6 节）：
// 1. 取 4 个回看周期（250/120/60/20 交易日）的复权收益率
// 2. 每个周期分别在全市场做百分位排名（1–99）
// 3. 按 30% / 30% / 25% / 15% 加权，得到个股 RS
// 4. 按 stock_basic.industry 分组，取组内 RS 中位数作为行业强度，再对行业做百分位
// 5. L 得分 = RS 基础分 + 行业强度调整
//
// 成本说明：这是整套流程里最便宜的强力筛选。全市场 5500 只 × 4 个周期的收益率，
// 只需从本地库读 5 个交易日的截面（基准日 + 4 个回看起点），
// 不需要逐只拉历史，也不需要任何在线接口调用。
//
// 复权处理：收益率一律用 adjClose（close × adj_factor）计算。
// 若直接用不复权价，跨越除权除息日的个股会凭空出现巨额「跌幅」，RS 完全失真。

import type { Database } from "bun:sqlite";
import { getAdjCloseMap, getTradeDateOffset, countBarsForCodes } from "../repository";
import type { CanSlimConfig } from "../config";
import type { FactorResult, StockBasicRow } from "../types";
import { degraded } from "../types";

/** 行业强度信息 */
export interface IndustryStrength {
  industry: string;
  /** 组内个股 RS 的中位数 */
  medianRs: number;
  /** 该行业在所有行业中的百分位（1–99） */
  percentile: number;
  /** 组内样本数 */
  count: number;
}

/** L 因子的批量计算结果 */
export interface LeaderResult {
  /** ts_code -> 因子结果（metrics 里带 rs / 各周期收益与分位 / 行业分位） */
  byCode: Map<string, FactorResult>;
  /** 行业强度排行（按 medianRs 降序） */
  industries: IndustryStrength[];
  /** 参与排名的样本数（即有效基准日价格的股票数） */
  universeSize: number;
  /** 各回看周期实际使用的起始交易日；null 表示本地库历史不足 */
  lookbackDates: { days: number; startDate: string | null; weight: number }[];
}

/**
 * 计算一组数值的百分位排名（1–99）。
 *
 * 并列值取相同分位（用并列区间的平均排名），避免同收益率的股票被人为分出高低。
 * 只有 1 个样本时返回 50（中位），避免出现「唯一样本即最强」的假象。
 */
function percentileRanks(values: Map<string, number>): Map<string, number> {
  const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const result = new Map<string, number>();
  if (n === 0) return result;
  if (n === 1) {
    result.set(entries[0]![0], 50);
    return result;
  }

  let i = 0;
  while (i < n) {
    const currentValue = entries[i]![1];
    // 找出并列区间 [i, j]
    let j = i;
    while (j + 1 < n && entries[j + 1]![1] === currentValue) j++;

    const avgRank = (i + j) / 2; // 0-based 平均排名
    const pct = Math.round((avgRank / (n - 1)) * 98) + 1; // 映射到 1–99
    for (let k = i; k <= j; k++) {
      result.set(entries[k]![0], pct);
    }
    i = j + 1;
  }
  return result;
}

/** 取中位数（输入需非空） */
function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** 限制到 [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 计算全市场的 L 因子。
 *
 * 必须整体计算而非逐只计算：百分位排名的定义就依赖完整样本。
 *
 * @param db 本地库
 * @param asOfDate 基准日（强制只用该日及之前数据）
 * @param cfg 生效配置
 * @param universe 参与排名的股票池（已排除 ST / 北交所等）
 * @param basicMap ts_code -> 基础信息（取 industry 用）
 */
export function computeLeaderFactors(
  db: Database,
  asOfDate: string,
  cfg: CanSlimConfig,
  universe: StockBasicRow[],
  basicMap?: Map<string, StockBasicRow>
): LeaderResult {
  const {
    rsLookbacks,
    rsMin,
    rsStrong,
    rsGood,
    rsWeak,
    industryTopRatio,
    minTradingDays,
    rsWeightInScore,
    industryWeightInScore,
  } = cfg.l;

  const byCode = new Map<string, FactorResult>();
  const universeCodes = universe.map((s) => s.ts_code);
  const codeSet = new Set(universeCodes);
  const industryOf = new Map<string, string>();
  for (const s of universe) {
    industryOf.set(s.ts_code, s.industry || "未分类");
  }
  void basicMap; // 保留参数以兼容调用方，industry 已由 universe 提供

  // 基准日全市场复权价
  const baseMap = getAdjCloseMap(db, asOfDate);

  // 各回看周期的起始交易日
  const lookbackDates = rsLookbacks.map((lb) => ({
    days: lb.days,
    weight: lb.weight,
    startDate: getTradeDateOffset(db, asOfDate, lb.days),
  }));

  // 每只股票的可交易天数，用于「上市不足」降级判定
  const barCounts = countBarsForCodes(db, universeCodes, asOfDate);

  // 逐周期计算收益率并做百分位排名
  // periodReturns: days -> (ts_code -> 收益率)
  const periodReturns = new Map<number, Map<string, number>>();
  const periodRanks = new Map<number, Map<string, number>>();

  for (const lb of lookbackDates) {
    const returns = new Map<string, number>();
    if (lb.startDate) {
      const startMap = getAdjCloseMap(db, lb.startDate);
      for (const code of universeCodes) {
        const now = baseMap.get(code);
        const before = startMap.get(code);
        // 两端都要有价格才能算收益；缺任一端说明当时停牌或尚未上市
        if (now !== undefined && before !== undefined && before > 0) {
          returns.set(code, (now / before - 1) * 100);
        }
      }
    }
    periodReturns.set(lb.days, returns);
    periodRanks.set(lb.days, percentileRanks(returns));
  }

  // 合成加权强度分：对缺失周期做权重归一化，而不是直接当 0 分处理
  const weightedScores = new Map<string, number>();
  for (const code of universeCodes) {
    let weighted = 0;
    let usedWeight = 0;
    for (const lb of lookbackDates) {
      const pct = periodRanks.get(lb.days)?.get(code);
      if (pct !== undefined) {
        weighted += pct * lb.weight;
        usedWeight += lb.weight;
      }
    }
    if (usedWeight > 0) {
      weightedScores.set(code, weighted / usedWeight);
    }
  }

  // 对加权分再做一次全市场百分位映射，得到最终 RS。
  //
  // 这一步不能省：多个周期的分位加权平均后，分布会向中间收敛（中心极限效应），
  // 直接把它当 RS 会让「RS ≥ 70」实际只筛出前 17% 而不是前 30%，阈值语义失真。
  // IBD 的 RS Rating 本身就定义为最终排名的百分位，所以再排一次名才符合原始定义，
  // 也让配置里的 rsMin / rsGood / rsStrong 能按「前百分之几」直接理解。
  const rsMap = percentileRanks(weightedScores);

  // 行业强度：组内 RS 中位数 → 行业百分位
  const industryGroups = new Map<string, number[]>();
  for (const [code, rs] of rsMap) {
    const ind = industryOf.get(code) ?? "未分类";
    const list = industryGroups.get(ind);
    if (list) list.push(rs);
    else industryGroups.set(ind, [rs]);
  }

  const industryMedians = new Map<string, number>();
  for (const [ind, list] of industryGroups) {
    industryMedians.set(ind, median(list));
  }
  const industryPercentiles = percentileRanks(industryMedians);

  const industries: IndustryStrength[] = [...industryGroups.entries()]
    .map(([industry, list]) => ({
      industry,
      medianRs: Math.round((industryMedians.get(industry) ?? 0) * 10) / 10,
      percentile: industryPercentiles.get(industry) ?? 50,
      count: list.length,
    }))
    .sort((a, b) => b.medianRs - a.medianRs);

  // 强势行业分位下限（industryTopRatio = 0.2 → 分位 ≥ 80 视为前 20%）
  const strongIndustryPct = Math.round((1 - industryTopRatio) * 100);
  const weakIndustryPct = Math.round(industryTopRatio * 100);

  // 逐只组装因子结果
  for (const code of universeCodes) {
    const bars = barCounts.get(code) ?? 0;
    const rs = rsMap.get(code);

    // 历史不足：无法可靠计算 RS，降级
    if (bars < minTradingDays) {
      byCode.set(
        code,
        degraded(`本地库仅有 ${bars} 个交易日数据（需 ${minTradingDays}），上市时间过短或历史缺失`)
      );
      continue;
    }
    if (rs === undefined) {
      byCode.set(code, degraded("基准日无有效行情（可能停牌），无法计算相对强度"));
      continue;
    }

    const rsRounded = Math.round(rs);
    const ind = industryOf.get(code) ?? "未分类";
    const indPct = industryPercentiles.get(ind) ?? 50;

    // 行业强度定性说明（用于可解释输出）
    let industryNote: string;
    if (indPct >= strongIndustryPct) {
      industryNote = `所属行业「${ind}」强度分位 ${indPct}，位居前 ${Math.round(industryTopRatio * 100)}%（龙头行业）`;
    } else if (indPct >= 60) {
      industryNote = `所属行业「${ind}」强度分位 ${indPct}，中等偏强`;
    } else if (indPct <= weakIndustryPct) {
      industryNote = `所属行业「${ind}」强度分位 ${indPct}，属于落后行业`;
    } else {
      industryNote = `所属行业「${ind}」强度分位 ${indPct}，中等`;
    }

    // L 得分 = 个股 RS 与行业强度分位的加权混合。
    // 两者都已是 1–99 的百分位，量纲一致，混合后天然落在 0–100，
    // 且不会像「RS + 固定加分」那样让强势股大量饱和在满分。
    const score = clamp(
      rsRounded * rsWeightInScore + indPct * industryWeightInScore,
      0,
      100
    );

    // 档位说明，沿用规格里的 90 / 80 / 70 / 50 划分
    const tier =
      rsRounded >= rsStrong
        ? "极强（前 10%）"
        : rsRounded >= rsGood
          ? "强势"
          : rsRounded >= rsMin
            ? "合格"
            : rsRounded >= rsWeak
              ? "偏弱"
              : "落后";

    const details: string[] = [
      `市场 RS = ${rsRounded}（${tier}，即全市场前 ${100 - rsRounded}%）`,
    ];
    // 逐周期明细，让「为什么强」可追溯
    for (const lb of lookbackDates) {
      const ret = periodReturns.get(lb.days)?.get(code);
      const pct = periodRanks.get(lb.days)?.get(code);
      if (ret !== undefined && pct !== undefined) {
        details.push(
          `${lb.days} 日收益 ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%，分位 ${pct}（权重 ${(lb.weight * 100).toFixed(0)}%）`
        );
      } else {
        details.push(`${lb.days} 日数据缺失，该周期未参与加权`);
      }
    }
    details.push(industryNote);

    const metrics: Record<string, number | string | null> = {
      rs: rsRounded,
      // 映射前的加权强度分，保留用于诊断「RS 排名是怎么来的」
      rsWeightedScore: Math.round((weightedScores.get(code) ?? 0) * 10) / 10,
      industry: ind,
      industryPercentile: indPct,
      industryMedianRs: Math.round((industryMedians.get(ind) ?? 0) * 10) / 10,
      tradingDays: bars,
    };
    for (const lb of lookbackDates) {
      const ret = periodReturns.get(lb.days)?.get(code);
      const pct = periodRanks.get(lb.days)?.get(code);
      metrics[`return${lb.days}`] = ret === undefined ? null : Math.round(ret * 100) / 100;
      metrics[`percentile${lb.days}`] = pct ?? null;
    }

    byCode.set(code, { score, details, metrics });
  }

  return {
    byCode,
    industries,
    universeSize: rsMap.size,
    lookbackDates,
  };
}

/**
 * 从 L 因子结果中取出 RS 值（未算出则返回 null）。
 * 供硬门槛筛选使用，避免调用方到处写 metrics 取值。
 */
export function getRs(result: FactorResult | undefined): number | null {
  if (!result || result.score === null) return null;
  const rs = result.metrics?.rs;
  return typeof rs === "number" ? rs : null;
}

/**
 * 判断是否通过 RS 硬门槛。
 * 降级（score 为 null）的股票视为未通过——RS 是 CAN SLIM 的核心条件，
 * 缺这项数据的股票不应进入候选。
 */
export function passRsGate(result: FactorResult | undefined, cfg: CanSlimConfig): boolean {
  const rs = getRs(result);
  return rs !== null && rs >= cfg.l.rsMin;
}

/** 构造股票池：排除 ST、北交所、上市不足等（对应 config.screen） */
export function buildUniverse(
  stocks: StockBasicRow[],
  cfg: CanSlimConfig
): { universe: StockBasicRow[]; excluded: { ts_code: string; name: string; reason: string }[] } {
  const universe: StockBasicRow[] = [];
  const excluded: { ts_code: string; name: string; reason: string }[] = [];

  for (const s of stocks) {
    if (cfg.screen.excludeSt && /ST/i.test(s.name)) {
      excluded.push({ ts_code: s.ts_code, name: s.name, reason: "ST / *ST 股票" });
      continue;
    }
    if (cfg.screen.excludeBse && s.market === "北交所") {
      excluded.push({ ts_code: s.ts_code, name: s.name, reason: "北交所（流动性与制度差异）" });
      continue;
    }
    // 退市整理期、暂停上市等名称标记
    if (/退|退市/.test(s.name)) {
      excluded.push({ ts_code: s.ts_code, name: s.name, reason: "退市相关" });
      continue;
    }
    universe.push(s);
  }

  return { universe, excluded };
}
