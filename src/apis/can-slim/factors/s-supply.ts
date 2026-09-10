// S 因子：供需（Supply & Demand）
//
// 核心思想：股价上涨的本质之一是需求超过供给。可观测的代理指标有两类——
// 一是量价关系（价涨量增说明有真实买盘承接，价跌量增说明抛压在释放），
// 二是供给规模（流通盘越小，同等资金推动力越强）。
//
// 五个子项加权（权重见 config.s.subWeights）：
//   1. 量价关系（0.40）：当日涨跌方向 × 量能相对均量的倍数
//   2. 换手率（0.20）：自由流通口径，过低说明无人关注，过高说明过热
//   3. 量比（0.15）：当日均量相对近期均量的活跃度
//   4. 流通市值（0.15）：按分档给分，中小盘得分最高
//   5. 股东人数变化（0.10）：人数下降 = 筹码集中；数据不可用时权重摊给其余子项
//
// 换手率优先用 turnover_rate_f（自由流通股口径）。相比总流通股口径，
// 它剔除了大股东长期锁仓的部分，更贴近「真实可交易筹码的换手强度」，
// 也更接近 CAN SLIM 讨论供给时的语义。

import type { Bar } from "../repository";
import type { CanSlimConfig } from "../config";
import type { DailyBasicRow, FactorResult } from "../types";
import { degraded } from "../types";

/** 股东人数变化（由 I 因子层批量取得后传入，可选） */
export interface HolderNumChange {
  /** 最新一期股东户数 */
  latest: number;
  /** 上一期股东户数 */
  previous: number;
  /** 环比变化百分比（负数表示人数减少 = 筹码集中） */
  changePct: number;
  /** 最新一期的截止日期 */
  endDate: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 量价关系子项评分。
 *
 * 判定逻辑刻意做成非对称：上涨放量是正面信号，下跌放量是负面信号，
 * 而上涨缩量（无量上涨，持续性差）与下跌缩量（抛压衰减）都只算中性偏弱。
 */
function scorePriceVolume(
  bars: Bar[],
  cfg: CanSlimConfig
): { score: number; detail: string; volRatio: number } {
  const last = bars[bars.length - 1]!;
  const prior = bars.slice(0, -1).slice(-cfg.s.volumeMaDays);
  const avgVol =
    prior.length > 0 ? prior.reduce((s, b) => s + b.vol, 0) / prior.length : 0;
  const volRatio = avgVol > 0 ? last.vol / avgVol : 0;
  const up = last.pct_chg > 0;
  const surge = volRatio >= cfg.s.surgeVolumeRatio;

  if (up && surge) {
    // 放量上涨：需求明确超过供给。量能越大给分越高，但设上限避免异常放量拿满分
    const score = clamp(80 + (volRatio - cfg.s.surgeVolumeRatio) * 20, 80, 100);
    return {
      score,
      detail: `上涨 ${last.pct_chg.toFixed(2)}% 且成交量为 ${cfg.s.volumeMaDays} 日均量的 ${volRatio.toFixed(2)} 倍，放量上涨`,
      volRatio,
    };
  }
  if (up && !surge) {
    // 温和放量到缩量上涨：按量能线性给 45~75 分
    const score = clamp(45 + (volRatio - 0.5) * 30, 40, 75);
    return {
      score,
      detail: `上涨 ${last.pct_chg.toFixed(2)}%，成交量为均量的 ${volRatio.toFixed(2)} 倍，量能未明显放大`,
      volRatio,
    };
  }
  if (!up && surge) {
    // 放量下跌：供给压力明显
    const score = clamp(25 - (volRatio - cfg.s.surgeVolumeRatio) * 10, 5, 25);
    return {
      score,
      detail: `下跌 ${last.pct_chg.toFixed(2)}% 且成交量为均量的 ${volRatio.toFixed(2)} 倍，放量下跌，抛压较重`,
      volRatio,
    };
  }
  // 缩量下跌：抛压在衰减，中性
  return {
    score: 45,
    detail: `下跌 ${last.pct_chg.toFixed(2)}%，成交量为均量的 ${volRatio.toFixed(2)} 倍，缩量回调`,
    volRatio,
  };
}

/** 换手率子项评分：最佳区间给满分，两端衰减 */
function scoreTurnover(
  turnover: number,
  cfg: CanSlimConfig
): { score: number; detail: string } {
  const { turnoverMin, turnoverMax, turnoverSweetMin, turnoverSweetMax } = cfg.s;

  if (turnover <= 0) {
    return { score: 0, detail: "换手率数据缺失或为 0" };
  }
  if (turnover < turnoverMin) {
    return {
      score: 10,
      detail: `自由流通换手率 ${turnover.toFixed(2)}%，低于 ${turnoverMin}%，交投极度清淡`,
    };
  }
  if (turnover < turnoverSweetMin) {
    // turnoverMin ~ sweetMin：线性 30 → 100
    const score = 30 + ((turnover - turnoverMin) / (turnoverSweetMin - turnoverMin)) * 70;
    return {
      score: clamp(score, 30, 100),
      detail: `自由流通换手率 ${turnover.toFixed(2)}%，活跃度偏低`,
    };
  }
  if (turnover <= turnoverSweetMax) {
    return {
      score: 100,
      detail: `自由流通换手率 ${turnover.toFixed(2)}%，处于 ${turnoverSweetMin}%~${turnoverSweetMax}% 的活跃区间`,
    };
  }
  if (turnover <= turnoverMax) {
    // sweetMax ~ max：线性 100 → 40，过热扣分
    const score = 100 - ((turnover - turnoverSweetMax) / (turnoverMax - turnoverSweetMax)) * 60;
    return {
      score: clamp(score, 40, 100),
      detail: `自由流通换手率 ${turnover.toFixed(2)}%，高于活跃区间，交投偏过热`,
    };
  }
  return {
    score: 20,
    detail: `自由流通换手率 ${turnover.toFixed(2)}%，超过 ${turnoverMax}%，短线过热风险高`,
  };
}

/** 量比子项评分 */
function scoreVolumeRatio(
  volumeRatio: number,
  cfg: CanSlimConfig
): { score: number; detail: string } {
  const { volumeRatioMin, volumeRatioStrong } = cfg.s;
  if (volumeRatio <= 0) {
    return { score: 40, detail: "量比数据缺失" };
  }
  if (volumeRatio >= volumeRatioStrong) {
    return {
      score: clamp(85 + (volumeRatio - volumeRatioStrong) * 10, 85, 100),
      detail: `量比 ${volumeRatio.toFixed(2)}，明显活跃`,
    };
  }
  if (volumeRatio >= volumeRatioMin) {
    const score = 60 + ((volumeRatio - volumeRatioMin) / (volumeRatioStrong - volumeRatioMin)) * 25;
    return { score: clamp(score, 60, 85), detail: `量比 ${volumeRatio.toFixed(2)}，高于 1` };
  }
  return {
    score: clamp(volumeRatio * 55, 5, 55),
    detail: `量比 ${volumeRatio.toFixed(2)}，低于 1，当日交投弱于近期`,
  };
}

/** 流通市值子项评分（按分档） */
function scoreCircMv(circMv: number, cfg: CanSlimConfig): { score: number; detail: string } {
  if (circMv <= 0) {
    return { score: 50, detail: "流通市值数据缺失" };
  }
  for (const tier of cfg.s.circMvTiers) {
    if (circMv <= tier.maxCircMv) {
      const yi = circMv / 10000; // 万元 → 亿元
      return { score: tier.score, detail: `流通市值 ${yi.toFixed(1)} 亿元，${tier.label}` };
    }
  }
  return { score: 50, detail: `流通市值 ${(circMv / 10000).toFixed(1)} 亿元` };
}

/** 股东人数子项评分：人数减少视为筹码集中 */
function scoreHolderNum(
  change: HolderNumChange,
  cfg: CanSlimConfig
): { score: number; detail: string } {
  const { holderNumDropPct } = cfg.s;
  const pct = change.changePct;

  if (pct <= -holderNumDropPct) {
    return {
      score: clamp(80 + Math.min(Math.abs(pct) - holderNumDropPct, 20), 80, 100),
      detail: `股东户数环比减少 ${Math.abs(pct).toFixed(1)}%（${change.previous} → ${change.latest}，截至 ${change.endDate}），筹码趋于集中`,
    };
  }
  if (pct < 0) {
    return {
      score: 65,
      detail: `股东户数环比小幅减少 ${Math.abs(pct).toFixed(1)}%（截至 ${change.endDate}）`,
    };
  }
  if (pct <= holderNumDropPct) {
    return {
      score: 45,
      detail: `股东户数环比基本持平（+${pct.toFixed(1)}%，截至 ${change.endDate}）`,
    };
  }
  return {
    score: clamp(35 - (pct - holderNumDropPct), 10, 35),
    detail: `股东户数环比增加 ${pct.toFixed(1)}%（截至 ${change.endDate}），筹码趋于分散`,
  };
}

/**
 * 计算 S 因子。
 *
 * @param bars 升序复权 K 线，末位为基准日（需至少 volumeMaDays + 1 根）
 * @param basic 基准日的 daily_basic 行；缺失则整个因子降级
 * @param holderChange 股东户数变化（可选）；缺失时该子项权重摊给其余子项
 * @param cfg 生效配置
 */
export function computeSupplyFactor(
  bars: Bar[],
  basic: DailyBasicRow | null | undefined,
  holderChange: HolderNumChange | null | undefined,
  cfg: CanSlimConfig
): FactorResult {
  if (bars.length < cfg.s.volumeMaDays + 1) {
    return degraded(
      `仅有 ${bars.length} 个交易日数据（需 ${cfg.s.volumeMaDays + 1}），无法计算量能基准`
    );
  }
  if (!basic) {
    return degraded("缺少基准日 daily_basic 数据（换手率、量比、流通市值均不可用）");
  }

  const w = cfg.s.subWeights;

  const pv = scorePriceVolume(bars, cfg);
  // 自由流通换手率优先，缺失时退回总流通口径
  const turnoverUsed = basic.turnover_rate_f > 0 ? basic.turnover_rate_f : basic.turnover_rate;
  const to = scoreTurnover(turnoverUsed, cfg);
  const vr = scoreVolumeRatio(basic.volume_ratio, cfg);
  const cm = scoreCircMv(basic.circ_mv, cfg);
  const hn = holderChange ? scoreHolderNum(holderChange, cfg) : null;

  // 加权合成；股东人数缺失时把它的权重按比例摊给其余四项
  const items: { score: number; weight: number }[] = [
    { score: pv.score, weight: w.priceVolume },
    { score: to.score, weight: w.turnover },
    { score: vr.score, weight: w.volumeRatio },
    { score: cm.score, weight: w.circMv },
  ];
  if (hn) items.push({ score: hn.score, weight: w.holderNum });

  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  const score = clamp(
    items.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight,
    0,
    100
  );

  const details = [pv.detail, to.detail, vr.detail, cm.detail];
  if (hn) {
    details.push(hn.detail);
  } else {
    details.push("股东户数数据未获取，该子项不参与 S 评分");
  }

  // 涨跌停提示：基准日已封板时，次日按参考价买入未必成交
  const limitNote = describeLimitStatus(basic.limit_status);
  if (limitNote) details.push(limitNote);

  return {
    score,
    details,
    metrics: {
      priceVolumeScore: Math.round(pv.score * 10) / 10,
      volumeVsMa: Math.round(pv.volRatio * 100) / 100,
      turnoverRateUsed: Math.round(turnoverUsed * 100) / 100,
      turnoverScore: Math.round(to.score * 10) / 10,
      volumeRatio: basic.volume_ratio,
      volumeRatioScore: Math.round(vr.score * 10) / 10,
      circMv: basic.circ_mv,
      circMvScore: cm.score,
      freeShare: basic.free_share,
      holderNumScore: hn ? Math.round(hn.score * 10) / 10 : null,
      holderNumChangePct: holderChange ? Math.round(holderChange.changePct * 100) / 100 : null,
      limitStatus: basic.limit_status,
      pctChg: bars[bars.length - 1]!.pct_chg,
    },
  };
}

/** 把 limit_status 翻译成可读提示；正常涨跌返回 null */
export function describeLimitStatus(status: number | null): string | null {
  switch (status) {
    case 2:
      return "⚠️ 基准日收盘涨停，次日可能无法按参考价买入";
    case 3:
      return "⚠️ 基准日一字涨停，次日大概率无法按参考价买入";
    case 5:
      return "⚠️ 基准日收盘跌停";
    case 6:
      return "⚠️ 基准日一字跌停";
    default:
      return null;
  }
}

/** 基准日是否处于涨停状态（买入信号需据此提示风险） */
export function isLimitUp(status: number | null): boolean {
  return status === 2 || status === 3;
}
