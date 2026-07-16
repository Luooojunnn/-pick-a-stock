// 分时对比大盘（需求 8）：占位模块，当前分钟权限未开通，默认禁用。
// 对应 design.md「分时对比占位（intraday.ts，需求 8）」章节。
//
// 设计要点：
// - 以 INTRADAY_ENABLED 开关控制是否启用；当前为 false。
// - 禁用时 applyIntradayFilter 原样透传候选、不调用任何分钟接口（stk_mins/idx_mins）、不排除任何股票（需求 8.6）。
// - 换算涨跌幅、对齐时间点比较、占比计算等纯逻辑拆为纯函数，
//   便于在无权限时也能独立单元测试；分钟权限开通后仅需置位并接入取数。

import type { FilterDecision, ScreeningContext } from "../types";
import { isValidNumber } from "./common";

/** 分钟权限开关：开通后置为 true 以启用需求 8 的分时对比筛选 */
export const INTRADAY_ENABLED = false;

/** 占比阈值：个股相对大盘的强势占比 ≥ 0.5 时保留（需求 8.4/8.5） */
export const INTRADAY_OUTPERFORM_THRESHOLD = 0.5;

/**
 * 单个分时数据点：对齐时间点标识与该时间点价格。
 * time 用于个股与指数在相同交易时段（09:30–11:30、13:00–15:00）上的对齐比较，
 * price 为该分钟的价格（如收盘价），用于以开盘价为基准换算涨跌幅。
 */
export interface MinuteBar {
  time: string; // 对齐时间点标识，如 "0930" 或 "09:31"
  price: number; // 该时间点价格
}

/** 分时对比占比计算结果 */
export interface OutperformResult {
  validPoints: number; // 有效对齐时间点总数（双方均有有效数据）
  outperformPoints: number; // 个股涨跌幅 ≥ 同刻大盘涨跌幅的对齐点数
  ratio: number; // 占比 = outperformPoints / validPoints；validPoints 为 0 时为 0
}

/**
 * 分时对比占位过滤：当前默认禁用（INTRADAY_ENABLED=false）。
 *
 * 禁用时：原样透传候选数组、不调用任何分钟接口、不排除任何股票（需求 8.6）。
 * 使用泛型以兼容工作态候选（WorkingCandidate）与最终候选（CandidateStock）。
 *
 * 分钟权限开通后（INTRADAY_ENABLED=true）：此处将接入 stk_mins/idx_mins 取数，
 * 并对每只候选调用 computeOutperformRatio + decideIntraday 完成判定。
 */
export async function applyIntradayFilter<T>(
  candidates: T[],
  ctx: ScreeningContext
): Promise<T[]> {
  // 禁用时直接透传，不触发任何分钟接口调用，不排除（需求 8.6）
  if (!INTRADAY_ENABLED || !ctx.intradayEnabled) {
    return candidates;
  }

  // 权限开通后的接入位置：为每只候选拉取 stk_mins/idx_mins 并调用纯比较函数判定。
  // 当前分钟权限未开通，保持透传以不阻塞需求 1–7 流程。
  return candidates;
}

/**
 * 以开盘价为基准，将某一时间点价格换算为涨跌幅百分比（需求 8.2）。
 *
 * 公式：(price - open) / open * 100
 * - open 或 price 为无效值，或 open ≤ 0（无法作为基准）→ 返回 null，视为该点无有效数据。
 */
export function toPctChg(open: unknown, price: unknown): number | null {
  if (!isValidNumber(open) || !isValidNumber(price)) return null;
  if (open <= 0) return null;
  return ((price - open) / open) * 100;
}

/**
 * 计算个股相对大盘的强势占比（需求 8.2/8.3）。
 *
 * - 个股与指数各自以其当日开盘价为基准换算涨跌幅百分比。
 * - 仅对双方均存在有效数据的对齐时间点进行比较（按 time 对齐）。
 * - 个股涨跌幅 ≥ 同一时刻大盘涨跌幅的对齐点计为一次「强势」。
 * - ratio = 强势对齐点数 / 有效对齐点总数；有效对齐点为 0 时 ratio 记为 0（由判定层决定不排除）。
 */
export function computeOutperformRatio(
  stockOpen: number,
  stockBars: MinuteBar[],
  indexOpen: number,
  indexBars: MinuteBar[]
): OutperformResult {
  // 建立指数时间点 → 涨跌幅 的映射，便于按时间对齐查找
  const indexPctByTime = new Map<string, number>();
  for (const bar of indexBars) {
    const pct = toPctChg(indexOpen, bar.price);
    if (pct !== null) indexPctByTime.set(bar.time, pct);
  }

  let validPoints = 0;
  let outperformPoints = 0;

  for (const bar of stockBars) {
    const stockPct = toPctChg(stockOpen, bar.price);
    if (stockPct === null) continue; // 个股该点无有效数据

    const indexPct = indexPctByTime.get(bar.time);
    if (indexPct === undefined) continue; // 大盘该时刻无有效数据 → 非有效对齐点

    // 双方均有有效数据 → 计为有效对齐点
    validPoints += 1;
    if (stockPct >= indexPct) outperformPoints += 1;
  }

  const ratio = validPoints > 0 ? outperformPoints / validPoints : 0;
  return { validPoints, outperformPoints, ratio };
}

/**
 * 依占比结果判定该股保留或排除（需求 8.4/8.5/8.6）。
 *
 * - 有效对齐点为 0 → 不排除该股（keep:true），此处不视为筛选依据（需求 8.6）。
 * - 占比 ≥ 阈值（默认 0.5）→ 保留（需求 8.4）。
 * - 占比 < 阈值 → 排除（需求 8.5）。
 */
export function decideIntraday(result: OutperformResult): FilterDecision {
  // 有效对齐点为 0：分时数据缺失/不可比，不因需求 8 排除任何股票（需求 8.6）
  if (result.validPoints === 0) {
    return { keep: true };
  }

  // 占比达到阈值 → 保留（需求 8.4）
  if (result.ratio >= INTRADAY_OUTPERFORM_THRESHOLD) {
    return { keep: true };
  }

  // 占比不足 → 排除（需求 8.5）
  return {
    keep: false,
    reason: `分时强势占比 ${result.ratio.toFixed(2)} 低于阈值 ${INTRADAY_OUTPERFORM_THRESHOLD}`,
  };
}
