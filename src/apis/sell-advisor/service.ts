// 服务编排层（service.ts）
// 端到端计算卖出建议：校验输入 → 获取历史行情 → 五层策略计算 → 评分与建议 → 组装结果。
// 严格对照 design.md「Components and Interfaces」第 7 节与「计算顺序与依赖」章节，
// 以及需求 2.4、2.5、5.5、6.3、9.8、10、11.2 实现。
//
// 关键约束：
// - 计算顺序为硬约束（评分 → 回撤比例定档 → 成交量收紧 → 移动止盈线 → 综合建议），
//   因存在跨层数据依赖，顺序在本层固定，不可调整。
// - 本层与 data-source 是仅有的副作用来源；其余全部为纯函数计算。
// - 计算失败（历史数据不足、接口失败/超时）统一抛 SellAdvisorError（→ HTTP 500），
//   且不返回任何部分结果（需求 11.6）。

import { fetchDailyHistory } from "./data-source";
import { atr14, highestClose, profitPct, round, sma, validBars } from "./indicators";
import { computeHealthScore } from "./strategy/health-score";
import { computeStopLoss } from "./strategy/stop-loss";
import { computeTakeProfit } from "./strategy/take-profit";
import { computeTrailingStop } from "./strategy/trailing-stop";
import { computeTrend } from "./strategy/trend";
import { decideSuggestion } from "./strategy/suggestion";
import { tightenRetreatRatio } from "./strategy/volume-confirm";
import {
  type DailyBar,
  type MASnapshot,
  type SellAdvice,
  SellAdvisorError,
} from "./types";
import { validatePositionInput } from "./validation";

/** 有效交易日数量下限：不足则历史数据不足，中止计算（需求 2.5、5.5、9.8） */
const MIN_VALID_BARS = 60;

/**
 * 依据健康评分档位确定初始回撤比例（需求 6.2、10.3、10.4）。
 * - [80, 100] → 0.08；
 * - [60, 80)  → 0.05；
 * - 其余（< 60）→ 0.05（默认，保证移动止盈线仍可计算）。
 */
function retreatRatioByScore(healthScore: number): number {
  if (healthScore >= 80) return 0.08;
  return 0.05;
}

/**
 * 在升序有效交易日中定位买入日的起始索引（需求 6.1）。
 * 返回首个满足 `trade_date >= buy_date` 的索引；若不存在（买入日晚于全部交易日）则返回 undefined。
 * trade_date 与 buy_date 均为 YYYYMMDD 字符串，可直接按字典序比较。
 */
function findBuyDateIndex(
  valid: DailyBar[],
  buyDate: string | undefined
): number | undefined {
  if (buyDate === undefined) return undefined;
  const idx = valid.findIndex((b) => b.trade_date >= buyDate);
  return idx === -1 ? undefined : idx;
}

/**
 * 端到端计算卖出建议（需求 2、11）。
 *
 * 编排步骤（顺序为硬约束）：
 * 1. 校验并规范化输入（非法 → ValidationError，由 HTTP 层转 400）。
 * 2. 获取升序历史日线（接口失败/超时 → SellAdvisorError，→ 500）。
 * 3. 提取有效交易日；为空或 < 60 个 → 抛 insufficient-data 错误（需求 2.5、5.5、9.8）。
 * 4. current_price（最近有效日 close）与 profit_pct（需求 2.4、3）。
 * 5. ATR14 → 成本止损（需求 4）。
 * 6. MA5/10/20/60 → 趋势判断（需求 5）。
 * 7. 健康评分（需求 9）。
 * 8. 由评分定回撤比例 → 成交量确认收紧 → 移动止盈线（需求 6、8、10.3、10.4）。
 * 9. 分批止盈（需求 7）。
 * 10. 综合建议（需求 10）。
 * 11. 组装并返回完整 SellAdvice（需求 11.2、6.3）。
 *
 * @param rawInput 前端提交的原始持仓输入（未校验）
 * @returns 完整的卖出建议结构
 */
export async function computeSellAdvice(rawInput: unknown): Promise<SellAdvice> {
  // —— 步骤 1：校验并规范化输入（非法由 validation 抛 ValidationError，→ 400）——
  const input = validatePositionInput(rawInput);

  // —— 步骤 2：获取升序历史日线；接口失败/超时由 data-source 抛 SellAdvisorError（→ 500）——
  const bars = await fetchDailyHistory(input.full_code);

  // —— 步骤 3：提取有效交易日；为空或 < 60 个 → 历史数据不足（需求 2.5、5.5、9.8）——
  const valid = validBars(bars);
  if (valid.length < MIN_VALID_BARS) {
    throw new SellAdvisorError("历史数据不足", undefined, "insufficient-data");
  }

  // —— 步骤 4：当前价（最近有效交易日 close，需求 2.4）与盈亏比例（需求 3）——
  const current_price = valid[valid.length - 1]!.close;
  const profit_pct = profitPct(current_price, input.cost);

  // 有效交易日的收盘价 / 成交量升序数组（供后续指标与评分复用）
  const closes = valid.map((b) => b.close);
  const volumes = valid.map((b) => b.vol);

  // —— 步骤 5：ATR14 → 成本止损（需求 4）——
  const atr = atr14(valid);
  const stopLoss = computeStopLoss(input.cost, atr, current_price);

  // —— 步骤 6：MA5/10/20/60（保留 2 位小数）→ 趋势判断（需求 5）——
  const endIndex = closes.length - 1;
  // 有效交易日 ≥ 60，MA5/10/20/60 均可计算；防御性地对 null 取 0（正常不会发生）
  const ma: MASnapshot = {
    ma5: round(sma(closes, 5, endIndex) ?? 0, 2),
    ma10: round(sma(closes, 10, endIndex) ?? 0, 2),
    ma20: round(sma(closes, 20, endIndex) ?? 0, 2),
    ma60: round(sma(closes, 60, endIndex) ?? 0, 2),
  };
  const trend = computeTrend(ma, current_price);

  // —— 步骤 7：健康评分（依赖趋势、盈亏、成交量、资金、止损，需求 9）——
  const scored = computeHealthScore({
    current_price,
    ma,
    profit_pct,
    recentVolumes: volumes,
    recentCloses: closes,
    stop_loss: stopLoss.stop_loss,
  });

  // —— 步骤 8：评分定回撤比例 → 成交量确认收紧 → 移动止盈线（需求 6、8、10.3、10.4）——
  const baseRatio = retreatRatioByScore(scored.health_score);
  const volumeConfirm = tightenRetreatRatio(baseRatio, valid);
  // 持有期最高价：提供 buy_date 时自买入日（含）起算，否则取全区间（需求 6.1）
  const fromIndex = findBuyDateIndex(valid, input.buy_date);
  const highest = highestClose(valid, fromIndex);
  const trailing = computeTrailingStop(
    highest,
    volumeConfirm.retreat_ratio,
    current_price
  );

  // —— 步骤 9：分批止盈（需求 7）——
  const take_profit = computeTakeProfit(input.cost, current_price);

  // —— 步骤 10：综合建议（止损/移动止盈触发优先、趋势转坏下调，需求 10）——
  const suggestion = decideSuggestion({
    current_price,
    stop_loss: stopLoss.stop_loss,
    trailing_stop: trailing.trailing_stop,
    health_score: scored.health_score,
    reduce_half: trend.reduce_half,
    cost_stop_triggered: stopLoss.cost_stop_triggered,
    trailing_triggered: trailing.trailing_triggered,
  });

  // —— 步骤 11：组装并返回完整 SellAdvice（需求 11.2、6.3）——
  return {
    // 盈亏（需求 3）
    current_price,
    cost: input.cost,
    profit_pct,
    // 成本止损（需求 4）
    fixed_stop_loss: stopLoss.fixed_stop_loss,
    atr_stop_loss: stopLoss.atr_stop_loss,
    stop_loss: stopLoss.stop_loss,
    cost_stop_triggered: stopLoss.cost_stop_triggered,
    // 趋势（需求 5）
    ma5: trend.ma5,
    ma10: trend.ma10,
    ma20: trend.ma20,
    ma60: trend.ma60,
    trend: trend.trend,
    reduce_half: trend.reduce_half,
    // 移动止盈（需求 6、8）
    highest_price: trailing.highest_price,
    trailing_stop: trailing.trailing_stop,
    trailing_triggered: trailing.trailing_triggered,
    retreat_ratio: volumeConfirm.retreat_ratio,
    volume_divergence: volumeConfirm.divergence,
    volume_confirm_executed: volumeConfirm.volume_confirm_executed,
    // 分批止盈（需求 7）
    take_profit,
    // 评分与建议（需求 9、10）
    health_score: scored.health_score,
    dimensions: scored.dimensions,
    suggestion,
  };
}
