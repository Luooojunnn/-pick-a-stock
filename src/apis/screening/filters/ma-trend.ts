// 需求 7：均线趋势分级判定
// 依据升序历史收盘价序列（末位为基准日）计算 MA5/MA10/MA20/MA60，
// 判定该股票是否保留，并给出"理想条件"（多头排列且四线向上）或"放宽条件"（仅 MA5/MA10 向上）分级。
// 分级互斥性由控制流保证：命中理想分支后直接返回，不再进入放宽分支。

import type { FilterDecision } from "../types";
import { sma, isRising } from "../ma";

/**
 * 均线趋势分级判定。
 *
 * 规则（需求 7.3–7.7）：
 * - 历史 close < 11 日（不足以计算基准日与前一日的 MA10）→ 排除并标数据不足（需求 7.7）
 * - MA5 或 MA10 不向上 → 排除（需求 7.5）
 * - ≥61 日且满足多头排列（MA5 > MA10 > MA20 > MA60）且四线均向上 → 仅"理想条件"（需求 7.3）
 * - 其余（含 <61 日、或不满足多头排列）但 MA5/MA10 向上 → "放宽条件"（需求 7.4、7.6）
 *
 * @param closes 升序历史收盘价序列（末位为基准日）
 * @returns 筛选决策：保留（含分级）或排除（含原因）
 */
export function classifyMaTrend(closes: number[]): FilterDecision {
  const n = closes.length;

  // 数据不足 11 日 → 排除并标数据不足（需求 7.7）
  if (n < 11) {
    return { keep: false, reason: "历史数据不足，无法评估" };
  }

  const end = n - 1; // 基准日索引
  const prev = n - 2; // 前一交易日索引

  // 某周期均线在基准日相对前一日是否向上
  const rising = (period: number) =>
    isRising(sma(closes, period, end), sma(closes, period, prev));

  const ma5Up = rising(5);
  const ma10Up = rising(10);

  // MA5 或 MA10 不向上 → 排除（需求 7.5）
  if (!ma5Up || !ma10Up) {
    return { keep: false, reason: "MA5或MA10不向上" };
  }

  // ≥61 日时才评估多头排列（需求 7.6 分支）
  if (n >= 61) {
    const ma5 = sma(closes, 5, end)!;
    const ma10 = sma(closes, 10, end)!;
    const ma20 = sma(closes, 20, end)!;
    const ma60 = sma(closes, 60, end)!;
    const bullishOrder = ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
    const allUp = rising(20) && rising(60);
    // 多头排列且四线向上 → 仅"理想条件"（需求 7.3）
    if (bullishOrder && allUp) {
      return { keep: true, grade: "理想条件" };
    }
  }

  // 其余情况：MA5/MA10 向上，但不满足理想条件 → "放宽条件"（需求 7.4、7.6）
  return { keep: true, grade: "放宽条件" };
}
