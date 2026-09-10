// 综合评分、市场开关与买入信号（scoring.ts）
//
// 三件事：
//
// 1. 六因子加权总分。权重来自 config.weights（C20/A15/N15/S10/L25/I15）。
//    某因子降级（score 为 null）时，它的权重按比例摊给其余可用因子，
//    而不是当 0 分计入——后者会让「数据缺失」变成「表现很差」，是两回事。
//
// 2. M 因子作为市场开关，而非总分的一项。这是 O'Neil 原意，也是规格第 8、9 节的要求：
//    牛市门槛 75，中性市门槛 85，熊市不产生买入信号（门槛设为不可达的 101）。
//    好处是不会出现「大盘很差但个股分数被 M 拉低一点仍然入选」的情况。
//
// 3. 买入信号。CAN SLIM 不是「分数高就买」，还需要突破确认与量能配合。
//    第一版只实现最简单的突破形态，Cup with Handle 等留待后续。

import type { CanSlimConfig, MarketRegime } from "./config";
import type {
  FactorSet,
  FactorKey,
  BuySignal,
  GateResult,
  CanSlimCandidate,
} from "./types";
import type { Bar } from "./repository";
import { isBreakoutBuySetup } from "./factors/n-new";
import { isLimitUp, describeLimitStatus } from "./factors/s-supply";
import { passRsGate } from "./factors/l-leader";
import { passCurrentEarningsGate } from "./factors/c-current";
import { passAnnualEarningsGate } from "./factors/a-annual";

/** 因子键的固定顺序（按 CAN SLIM 字母序，用于稳定输出） */
export const FACTOR_KEYS: FactorKey[] = ["c", "a", "n", "s", "l", "i"];

/** 因子的中文名，用于可解释输出 */
export const FACTOR_NAMES: Record<FactorKey, string> = {
  c: "C 当季盈利",
  a: "A 年度盈利",
  n: "N 新高突破",
  s: "S 供需",
  l: "L 领导地位",
  i: "I 机构参与",
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 总分计算结果 */
export interface TotalScoreResult {
  total: number;
  /** 降级归一化后的实际权重 */
  effectiveWeights: Record<FactorKey, number>;
  /** 降级的因子及原因 */
  degradedFactors: { factor: FactorKey; reason: string }[];
}

/**
 * 计算六因子加权总分。
 *
 * 降级归一化：设可用因子的原始权重之和为 W，则每个可用因子的实际权重为 w_i / W。
 * 这样无论几个因子降级，实际权重之和恒为 1，总分始终可与其他股票比较。
 *
 * 全部因子都降级时返回总分 0，并把全部因子标记为降级——
 * 调用方应据此把该股排除，而不是当成 0 分候选。
 */
export function computeTotalScore(
  factors: FactorSet,
  cfg: CanSlimConfig
): TotalScoreResult {
  const degradedFactors: { factor: FactorKey; reason: string }[] = [];
  const available: { key: FactorKey; score: number; weight: number }[] = [];

  for (const key of FACTOR_KEYS) {
    const result = factors[key];
    const weight = cfg.weights[key];
    if (result.score === null) {
      degradedFactors.push({
        factor: key,
        reason: result.degradedReason ?? "数据不可用",
      });
    } else {
      available.push({ key, score: result.score, weight });
    }
  }

  const effectiveWeights: Record<FactorKey, number> = {
    c: 0,
    a: 0,
    n: 0,
    s: 0,
    l: 0,
    i: 0,
  };

  if (available.length === 0) {
    return { total: 0, effectiveWeights, degradedFactors };
  }

  const totalWeight = available.reduce((s, a) => s + a.weight, 0);
  let total = 0;
  for (const a of available) {
    const w = a.weight / totalWeight;
    effectiveWeights[a.key] = Math.round(w * 10000) / 10000;
    total += a.score * w;
  }

  return {
    total: clamp(Math.round(total * 10) / 10, 0, 100),
    effectiveWeights,
    degradedFactors,
  };
}

/**
 * 评估硬门槛。
 *
 * 按需求确认的「混合模式」：C / A / L 三项设硬门槛（成长性与相对强度是 CAN SLIM 的地基），
 * N / S / I 只参与评分不做否决（新高位置、量价、机构参与更适合作为程度问题而非资格问题）。
 */
export function evaluateGates(factors: FactorSet, cfg: CanSlimConfig): GateResult {
  const passed: Record<string, boolean> = {
    l: passRsGate(factors.l, cfg),
    c: passCurrentEarningsGate(factors.c, cfg),
    a: passAnnualEarningsGate(factors.a, cfg),
  };

  const failedReasons: string[] = [];

  if (!passed.l) {
    const rs = factors.l.metrics?.rs;
    failedReasons.push(
      factors.l.score === null
        ? `L 门槛未通过：${factors.l.degradedReason ?? "相对强度不可用"}`
        : `L 门槛未通过：RS ${rs} 低于 ${cfg.l.rsMin}`
    );
  }
  if (!passed.c) {
    failedReasons.push(
      factors.c.score === null
        ? `C 门槛未通过：${factors.c.degradedReason ?? "当季财务数据不可用"}`
        : `C 门槛未通过：单季扣非净利同比未达 ${cfg.c.quarterlyProfitYoyMin}% 或单季营收同比未达 ${cfg.c.quarterlySalesYoyMin}%`
    );
  }
  if (!passed.a) {
    failedReasons.push(
      factors.a.score === null
        ? `A 门槛未通过：${factors.a.degradedReason ?? "年度财务数据不可用"}`
        : `A 门槛未通过：${cfg.a.cagrYears} 年 EPS 复合增长未达 ${cfg.a.epsCagrMin}%`
    );
  }

  return {
    passed,
    failedReasons,
    allPassed: Object.values(passed).every(Boolean),
  };
}

/**
 * 判定买入信号。
 *
 * 四个条件全部满足才触发（规格第 10 节）：
 * - 市场环境不是熊市
 * - 综合总分达到当前市场环境对应的门槛
 * - 收盘突破 20/50 日新高
 * - 突破当日成交量 ≥ 20 日均量 × 1.4
 *
 * 止损价按买入价下方 stopLossPct 计算。规格明确要求「不能因为基本面好就取消止损」，
 * 所以这里无条件输出止损位。
 */
export function evaluateBuySignal(
  bars: Bar[],
  totalScore: number,
  regime: MarketRegime,
  limitStatus: number | null,
  cfg: CanSlimConfig
): BuySignal | null {
  const threshold = cfg.screen.scoreThreshold[regime];

  // 熊市：门槛设为不可达值，等价于「不产生买入信号，只输出观察列表」
  if (regime === "BEAR") return null;
  if (totalScore < threshold) return null;
  if (bars.length === 0) return null;
  if (!isBreakoutBuySetup(bars, cfg)) return null;

  const last = bars[bars.length - 1]!;
  const entryPrice = last.close;
  const stopLossPrice = entryPrice * (1 - cfg.risk.stopLossPct);

  const reasons: string[] = [
    `综合评分 ${totalScore.toFixed(1)} 达到${regime === "BULL" ? "多头市场" : "中性市场"}门槛 ${threshold}`,
    "收盘突破近期新高且成交量放大确认",
  ];

  const warnings: string[] = [];
  // 涨停提示：A 股 T+1 与涨跌停制度下，涨停当日的信号次日未必能按参考价成交
  const limitNote = describeLimitStatus(limitStatus);
  if (limitNote) warnings.push(limitNote);
  if (isLimitUp(limitStatus)) {
    warnings.push("建议等待回踩或以次日开盘价重新评估，不要盲目追高");
  }
  if (regime === "NEUTRAL") {
    warnings.push("大盘处于中性环境，建议降低仓位");
  }

  return {
    entryPrice: Math.round(entryPrice * 100) / 100,
    stopLossPrice: Math.round(stopLossPrice * 100) / 100,
    stopLossPct: cfg.risk.stopLossPct,
    reasons,
    warnings,
  };
}

/**
 * 组装一只候选股的完整结果。
 *
 * @param rank 排名（由调用方在排序后赋值，这里先占位）
 */
export function assembleCandidate(
  input: {
    ts_code: string;
    name: string;
    industry: string;
    market: string;
    close: number;
    pctChg: number;
    limitStatus: number | null;
    bars: Bar[];
  },
  factors: FactorSet,
  regime: MarketRegime,
  cfg: CanSlimConfig
): CanSlimCandidate {
  const { total, effectiveWeights, degradedFactors } = computeTotalScore(factors, cfg);
  const gates = evaluateGates(factors, cfg);
  const buySignal = evaluateBuySignal(input.bars, total, regime, input.limitStatus, cfg);

  return {
    rank: 0,
    ts_code: input.ts_code,
    name: input.name,
    industry: input.industry,
    market: input.market,
    close: input.close,
    pctChg: input.pctChg,
    totalScore: total,
    factors,
    degradedFactors,
    effectiveWeights,
    gates,
    buySignal,
  };
}

/**
 * 排序并赋予排名，截取前 topN。
 * 同分时用 L 因子得分作为次序（相对强度是 CAN SLIM 权重最高的单项）。
 */
export function rankCandidates(
  candidates: CanSlimCandidate[],
  cfg: CanSlimConfig
): CanSlimCandidate[] {
  const sorted = candidates.slice().sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const al = a.factors.l.score ?? 0;
    const bl = b.factors.l.score ?? 0;
    return bl - al;
  });

  const top = sorted.slice(0, cfg.screen.topN);
  top.forEach((c, i) => {
    c.rank = i + 1;
  });
  return top;
}

/**
 * 生成一只候选股的完整文字解释（对应规格第 19 节的输出样例）。
 * 前端可直接展示，也便于把结果贴到别处讨论。
 */
export function explainCandidate(candidate: CanSlimCandidate): string {
  const lines: string[] = [];
  lines.push(`${candidate.ts_code} ${candidate.name}（${candidate.industry}）`);
  lines.push(`综合评分 ${candidate.totalScore.toFixed(1)}`);

  for (const key of FACTOR_KEYS) {
    const f = candidate.factors[key];
    const weight = candidate.effectiveWeights[key];
    if (f.score === null) {
      lines.push(`${FACTOR_NAMES[key]}：数据不可用（${f.degradedReason ?? "未知原因"}）`);
      continue;
    }
    lines.push(
      `${FACTOR_NAMES[key]}：${f.score.toFixed(1)} 分（权重 ${(weight * 100).toFixed(1)}%）`
    );
    for (const d of f.details) lines.push(`  · ${d}`);
  }

  if (candidate.buySignal) {
    lines.push(
      `买入信号：参考价 ${candidate.buySignal.entryPrice}，止损价 ${candidate.buySignal.stopLossPrice}` +
        `（-${(candidate.buySignal.stopLossPct * 100).toFixed(0)}%）`
    );
    for (const w of candidate.buySignal.warnings) lines.push(`  ⚠️ ${w}`);
  } else {
    lines.push("买入信号：未触发（观察列表）");
  }

  if (!candidate.gates.allPassed) {
    for (const r of candidate.gates.failedReasons) lines.push(`  ⚠️ ${r}`);
  }

  return lines.join("\n");
}
