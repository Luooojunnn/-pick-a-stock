// 第一层策略——成本止损（保护本金）
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md "Components and Interfaces" 第 6 节与 requirements.md 需求 4 实现。

import { round } from "../indicators";

/** computeStopLoss 的返回结构（对应 SellAdvice 中的成本止损字段） */
export interface StopLossResult {
  /** 固定止损位：cost × 0.93，保留 2 位小数（需求 4.1） */
  fixed_stop_loss: number | null;
  /** ATR 动态止损位：cost - atr × 2，保留 2 位小数；ATR 不可用时为 null（需求 4.3、4.5） */
  atr_stop_loss: number | null;
  /** 推荐止损位：max(fixed, atr)；ATR 不可用时取 fixed（需求 4.4、4.5） */
  stop_loss: number | null;
  /** 成本止损触发标记：stop_loss 可用且 current_price ≤ stop_loss（需求 4.6） */
  cost_stop_triggered: boolean;
}

/**
 * 计算成本止损（第一层）。
 *
 * 规则：
 * - `cost` 缺失或 ≤ 0 时，三项止损字段均置 null、`cost_stop_triggered = false`（防御分支，需求 4.7）。
 * - `fixed_stop_loss = round(cost × 0.93, 2)`（需求 4.1）。
 * - ATR14 可用时：`atr_stop_loss = round(cost - atr × 2, 2)`，`stop_loss = max(fixed, atr)`（需求 4.3、4.4）。
 * - ATR14 不可用（null）时：`atr_stop_loss = null`，`stop_loss = fixed_stop_loss`（需求 4.5）。
 * - `cost_stop_triggered` 当且仅当 `stop_loss` 可用且 `current_price ≤ stop_loss`（需求 4.6）。
 *
 * @param cost 用户持仓成本单价（元）
 * @param atr ATR14 波动率；可用日不足 15 时由上游传入 null（需求 4.5）
 * @param currentPrice 当前价（最近有效交易日收盘价）
 */
export function computeStopLoss(
  cost: number,
  atr: number | null,
  currentPrice: number
): StopLossResult {
  // 防御分支：cost 缺失或非正数时不计算任何止损（需求 4.7）
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    return {
      fixed_stop_loss: null,
      atr_stop_loss: null,
      stop_loss: null,
      cost_stop_triggered: false,
    };
  }

  // 固定止损位：成本下方 7%（需求 4.1）
  const fixed_stop_loss = round(cost * 0.93, 2);

  // ATR 止损位与推荐止损位
  let atr_stop_loss: number | null;
  let stop_loss: number;
  if (typeof atr === "number" && Number.isFinite(atr)) {
    // ATR14 可用：动态止损位并取两者较大者（需求 4.3、4.4）
    atr_stop_loss = round(cost - atr * 2, 2);
    stop_loss = Math.max(fixed_stop_loss, atr_stop_loss);
  } else {
    // ATR14 不可用：atr_stop_loss 置 null，推荐止损位取固定止损位（需求 4.5）
    atr_stop_loss = null;
    stop_loss = fixed_stop_loss;
  }

  // 成本止损触发标记：当前价跌破推荐止损位（需求 4.6）
  const cost_stop_triggered =
    typeof currentPrice === "number" &&
    Number.isFinite(currentPrice) &&
    currentPrice <= stop_loss;

  return { fixed_stop_loss, atr_stop_loss, stop_loss, cost_stop_triggered };
}
