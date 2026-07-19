// 第二层策略——趋势判断
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md "Components and Interfaces" 第 6 节与 requirements.md 需求 5 实现。

import type { MASnapshot, TrendState } from "../types";

/** computeTrend 的返回结构（对应 SellAdvice 中的趋势字段） */
export interface TrendResult {
  /** MA5 数值（由上游按最近交易日计算并保留 2 位小数，需求 5.1） */
  ma5: number;
  /** MA10 数值 */
  ma10: number;
  /** MA20 数值 */
  ma20: number;
  /** MA60 数值 */
  ma60: number;
  /** 趋势状态标记，取值必属于四态集合（需求 5.6） */
  trend: TrendState;
  /** 趋势转坏时触发减仓 50% 标记（需求 5.3） */
  reduce_half: boolean;
}

/**
 * 计算趋势状态（第二层）。
 *
 * 规则：
 * - `current_price > ma5 且 ma5 > ma20 且 ma20 > ma60` → 强趋势，trend="强势"、reduce_half=false（需求 5.2）。
 * - `current_price < ma20 且 ma5 < ma20` → 短期趋势转坏，trend="转坏"、reduce_half=true（需求 5.3）。
 * - 既不满足强势也不满足转坏 → trend="中性"、reduce_half=false（需求 5.4）。
 * - 输出携带 ma5/ma10/ma20/ma60 数值，trend 取值必属于 {"强势","转坏","中性","数据不足"}（需求 5.6）。
 *
 * 注：MA 数据不足（"数据不足"态）由 service 层在有效交易日不足 60 个时统一处理（需求 5.5），
 * 本纯函数按传入的 MASnapshot 计算即可，不判定数据不足。
 *
 * @param ma 最近交易日的均线快照（MA5/MA10/MA20/MA60）
 * @param currentPrice 当前价（最近有效交易日收盘价）
 */
export function computeTrend(
  ma: MASnapshot,
  currentPrice: number
): TrendResult {
  const { ma5, ma10, ma20, ma60 } = ma;

  // 强趋势：价格站上 MA5 且均线呈多头排列（需求 5.2）
  const isStrong = currentPrice > ma5 && ma5 > ma20 && ma20 > ma60;
  // 短期趋势转坏：价格跌破 MA20 且短均线位于 MA20 下方（需求 5.3）
  const isWeak = currentPrice < ma20 && ma5 < ma20;

  let trend: TrendState;
  let reduce_half: boolean;
  if (isStrong) {
    // "强势"，不触发减仓（需求 5.2）
    trend = "强势";
    reduce_half = false;
  } else if (isWeak) {
    // "转坏"，触发减仓 50%（需求 5.3）
    trend = "转坏";
    reduce_half = true;
  } else {
    // 既非强势也非转坏 → "中性"，不触发减仓（需求 5.4）
    trend = "中性";
    reduce_half = false;
  }

  return { ma5, ma10, ma20, ma60, trend, reduce_half };
}
