// 第四层：分批止盈（take-profit）——纯函数（需求 7）
// 基于成本价给出两档分批减仓目标，逐步锁定利润，同时让剩余仓位跟随趋势。

import type { TakeProfitTarget } from "../types";
import { round } from "../indicators";

/**
 * 计算分批止盈目标数组（需求 7.1、7.2、7.4、7.5）。
 *
 * 规则：
 * - 当 cost 为大于 0 的有效数值时，返回两档：
 *   - 第一档：price = round(cost × 1.20, 2)，ratio = 0.3，reason = "盈利20%锁定利润"
 *   - 第二档：price = round(cost × 1.40, 2)，ratio = 0.4，reason = "盈利40%继续减仓"
 * - 每档 reached：currentPrice 为有效数值且 ≥ 该档 price 时为 true；
 *   currentPrice 缺失或无效（null / NaN / 非有限数）时，所有档 reached 均为 false（需求 7.4）。
 * - 防御分支：cost 缺失、非数值或 ≤ 0 时返回空数组 []（需求 7.5）。
 *
 * 注：两档 ratio 合计 0.7（0.3 + 0.4），即两档止盈后仍保留 30% 仓位让利润奔跑（需求 7.3）。
 *
 * @param cost 用户持仓成本单价（元）
 * @param currentPrice 当前价，可能缺失/无效
 * @returns 分批止盈目标数组，长度为 0（cost 无效）或 2
 */
export function computeTakeProfit(
  cost: number,
  currentPrice: number | null
): TakeProfitTarget[] {
  // 防御分支：cost 缺失、非数值或 ≤ 0 → 返回空数组（需求 7.5）
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    return [];
  }

  // 判断 currentPrice 是否为有效数值（用于 reached 标记，需求 7.4）
  const priceValid =
    typeof currentPrice === "number" && Number.isFinite(currentPrice);

  const first: TakeProfitTarget = {
    price: round(cost * 1.2, 2),
    ratio: 0.3,
    reason: "盈利20%锁定利润",
    reached: false,
  };
  const second: TakeProfitTarget = {
    price: round(cost * 1.4, 2),
    ratio: 0.4,
    reason: "盈利40%继续减仓",
    reached: false,
  };

  // currentPrice 有效且 ≥ 目标价时标记该档已达到；无效时保持 false（需求 7.4）
  if (priceValid) {
    first.reached = (currentPrice as number) >= first.price;
    second.reached = (currentPrice as number) >= second.price;
  }

  return [first, second];
}
