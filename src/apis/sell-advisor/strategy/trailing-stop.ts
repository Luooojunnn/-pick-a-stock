// 第三层——移动止盈策略模块（how-to-sell / "我的股票合适卖"）
// 纯函数模块，无 I/O，输入持有期最高价、回撤比例与当前价，输出移动止盈线及触发标记。
// 严格对照 design.md "Components and Interfaces" 第 6 节与需求 6.2、6.4、6.5 实现。

import { round } from "../indicators";

/**
 * 计算移动止盈线及其触发标记（需求 6.2、6.4、6.5）。
 *
 * @param highestPrice 持有期最高价；不可用时为 null（需求 6.4）
 * @param retreatRatio 最终生效的回撤比例（由评分档位定档并经成交量确认收紧后得出）
 * @param currentPrice 当前价（最近有效交易日收盘价）
 * @returns
 *   - highest_price：持有期最高价（保留 2 位小数）；不可用时为 null
 *   - trailing_stop：移动止盈线 = round(highest_price × (1 - retreatRatio), 2)；
 *     highest_price 不可用时为 null（需求 6.2、6.4）
 *   - trailing_triggered：当且仅当 highest_price 与 trailing_stop 均可用
 *     且 currentPrice ≤ trailing_stop 时为 true（需求 6.5）
 */
export function computeTrailingStop(
  highestPrice: number | null,
  retreatRatio: number,
  currentPrice: number
): {
  highest_price: number | null;
  trailing_stop: number | null;
  trailing_triggered: boolean;
} {
  // highest_price 不可用（null）时，移动止盈线不可计算，触发标记恒为 false（需求 6.4）
  if (highestPrice == null) {
    return {
      highest_price: null,
      trailing_stop: null,
      trailing_triggered: false,
    };
  }

  // 最高价回传时保留 2 位小数（若上游未取整则在此处 round）
  const highest_price = round(highestPrice, 2);
  // 移动止盈线 = 最高价 × (1 - 回撤比例)，保留 2 位小数（需求 6.2）
  const trailing_stop = round(highest_price * (1 - retreatRatio), 2);
  // 当且仅当最高价与止盈线均可用且当前价 ≤ 止盈线时触发（需求 6.5）
  const trailing_triggered = currentPrice <= trailing_stop;

  return {
    highest_price,
    trailing_stop,
    trailing_triggered,
  };
}
