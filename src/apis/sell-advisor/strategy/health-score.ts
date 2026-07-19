// 健康评分模型（how-to-sell / "我的股票合适卖"）
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md "Components and Interfaces" 第 6 节与 requirements.md 需求 9 实现。

import type { DimensionScore, MASnapshot } from "../types";

/**
 * 健康评分入参（计算五维度所需的、已由上游提取好的数据）。
 * 说明：全部为纯数据，成交量 / 收盘价均按时间升序传入（数组末尾为最近交易日），
 * 使本函数保持纯净、可独立测试。
 */
export interface ScoreInputs {
  /** 当前价（最近有效交易日收盘价），用于趋势维度与风险维度 */
  current_price: number;
  /** 最近交易日的均线快照（MA5/MA10/MA20/MA60），用于趋势维度（需求 9.2） */
  ma: MASnapshot;
  /** 盈亏比例（%），用于价格维度（需求 9.3） */
  profit_pct: number;
  /**
   * 最近若干交易日成交量，按时间升序（末尾为最近交易日）。
   * 成交量维度取其中最近三日 V1、V2、V3（需求 9.4）。
   */
  recentVolumes: number[];
  /**
   * 最近若干交易日收盘价，按时间升序（末尾为最近交易日）。
   * 资金维度取其中最近两日收盘价（需求 9.5）。
   */
  recentCloses: number[];
  /** 推荐止损位；不可用时为 null，风险维度记 0 并标注不可计算（需求 9.6、9.9） */
  stop_loss: number | null;
}

/** computeHealthScore 的返回结构（对应 SellAdvice 中的评分字段） */
export interface HealthScoreResult {
  /** 健康评分：五维度得分之和，0–100 整数（需求 9.1、9.7） */
  health_score: number;
  /** 五维度得分明细（趋势 30 / 价格 20 / 成交量 20 / 资金 20 / 风险 10） */
  dimensions: DimensionScore[];
}

/**
 * 趋势维度得分（0–30，需求 9.2）。
 * - current > MA5 > MA20 > MA60 记 30；
 * - 否则 current > MA20 且 MA5 > MA20 记 20；
 * - 否则仅 current > MA20 记 10；
 * - 否则（current ≤ MA20）记 0。
 */
function scoreTrend(currentPrice: number, ma: MASnapshot): number {
  const { ma5, ma20, ma60 } = ma;
  if (currentPrice > ma5 && ma5 > ma20 && ma20 > ma60) return 30;
  if (currentPrice > ma20 && ma5 > ma20) return 20;
  if (currentPrice > ma20) return 10;
  return 0;
}

/**
 * 价格维度得分（0–20，需求 9.3）。
 * - profit_pct ≥ 20 记 20；
 * - [10, 20) 记 15；
 * - [0, 10) 记 10；
 * - [-7, 0) 记 5；
 * - < -7 记 0。
 */
function scorePrice(profitPct: number): number {
  if (profitPct >= 20) return 20;
  if (profitPct >= 10) return 15;
  if (profitPct >= 0) return 10;
  if (profitPct >= -7) return 5;
  return 0;
}

/**
 * 成交量维度得分（0–20，需求 9.4）。
 * 取最近三日成交量 (V1, V2, V3)（时间升序，V3 最近）：
 * - 严格递增 V1 < V2 < V3 记 20；
 * - 非严格递增 V1 ≤ V2 ≤ V3（但非严格）记 10；
 * - 其余记 0。
 * 防御：不足三日时记 0（正常情况下由服务层的历史数据充足性校验前置拦截，需求 9.8）。
 */
function scoreVolume(recentVolumes: number[]): number {
  const n = recentVolumes.length;
  if (n < 3) return 0;
  const v1 = recentVolumes[n - 3]!;
  const v2 = recentVolumes[n - 2]!;
  const v3 = recentVolumes[n - 1]!;
  if (v1 < v2 && v2 < v3) return 20;
  if (v1 <= v2 && v2 <= v3) return 10;
  return 0;
}

/**
 * 资金维度得分（0–20，需求 9.5）。
 * 取最近两日收盘价与成交量（时间升序，末尾为最近交易日）：
 * - 最近收盘价高于前一日且最近成交量高于前一日记 20；
 * - 收盘价高于前一日但成交量不高于前一日记 10；
 * - 收盘价不高于前一日（含持平与下跌）记 0。
 * 防御：不足两日时记 0（正常由服务层前置拦截，需求 9.8）。
 */
function scoreCapital(recentCloses: number[], recentVolumes: number[]): number {
  if (recentCloses.length < 2 || recentVolumes.length < 2) return 0;
  const recentClose = recentCloses[recentCloses.length - 1]!;
  const prevClose = recentCloses[recentCloses.length - 2]!;
  const recentVol = recentVolumes[recentVolumes.length - 1]!;
  const prevVol = recentVolumes[recentVolumes.length - 2]!;
  if (recentClose > prevClose) {
    return recentVol > prevVol ? 20 : 10;
  }
  return 0;
}

/**
 * 计算健康评分（第九节，依赖趋势、盈亏、成交量、资金、止损等已算数据）。
 *
 * 五维度求和为 0–100 的整数（需求 9.1、9.7），并输出各维度明细。
 * 风险维度在 stop_loss 不可用或 current_price ≤ 0 时记 0 并标注"风险维度不可计算"（需求 9.9）。
 *
 * @param inputs 计算五维度所需的入参
 */
export function computeHealthScore(inputs: ScoreInputs): HealthScoreResult {
  const { current_price, ma, profit_pct, recentVolumes, recentCloses, stop_loss } =
    inputs;

  // 趋势维度（0–30，需求 9.2）
  const trendScore = scoreTrend(current_price, ma);
  // 价格维度（0–20，需求 9.3）
  const priceScore = scorePrice(profit_pct);
  // 成交量维度（0–20，需求 9.4）
  const volumeScore = scoreVolume(recentVolumes);
  // 资金维度（0–20，需求 9.5）
  const capitalScore = scoreCapital(recentCloses, recentVolumes);

  // 风险维度（0–10，需求 9.6、9.9）
  let riskScore: number;
  let riskNote: string | undefined;
  if (
    stop_loss == null ||
    !Number.isFinite(stop_loss) ||
    !Number.isFinite(current_price) ||
    current_price <= 0
  ) {
    // stop_loss 不可用或 current_price ≤ 0 → 风险公式无法计算：记 0 并标注（需求 9.9）
    riskScore = 0;
    riskNote = "风险维度不可计算";
  } else {
    const m = ((current_price - stop_loss) / current_price) * 100;
    if (m > 5) riskScore = 10;
    else if (m >= 2) riskScore = 5; // 2 ≤ m ≤ 5（m > 5 已在上一分支排除）
    else riskScore = 0; // m < 2
  }

  const dimensions: DimensionScore[] = [
    { name: "趋势", score: trendScore, max: 30 },
    { name: "价格", score: priceScore, max: 20 },
    { name: "成交量", score: volumeScore, max: 20 },
    { name: "资金", score: capitalScore, max: 20 },
    { name: "风险", score: riskScore, max: 10, ...(riskNote ? { note: riskNote } : {}) },
  ];

  // 健康评分为五维度之和，各维度均为整数，合计天然落在 0–100 整数区间（需求 9.1、9.7）
  const health_score =
    trendScore + priceScore + volumeScore + capitalScore + riskScore;

  return { health_score, dimensions };
}
