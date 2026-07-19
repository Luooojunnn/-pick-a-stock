// 第五层策略——成交量确认（识别缩量上涨风险）
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md "Components and Interfaces" 第 6 节与 requirements.md 需求 8 实现。

import type { DailyBar } from "../types";
import { changePct, validBars } from "../indicators";

/** tightenRetreatRatio 的返回结构（对应 SellAdvice 中的成交量确认相关字段） */
export interface VolumeConfirmResult {
  /** 最终生效的回撤比例：量价背离时在 baseRatio 基础上收紧 0.02（下限 0），否则等于 baseRatio（需求 8.3） */
  retreat_ratio: number;
  /** 是否判定为量价背离：价格变动 > 0% 且成交量变动 < -20%（需求 8.2） */
  divergence: boolean;
  /** 成交量确认是否执行：有效交易日不足 2 个或成交量不可用时为 false（需求 8.4） */
  volume_confirm_executed: boolean;
}

/**
 * 成交量确认（第五层）：结合最近两个交易日的价、量判断量价是否背离，
 * 并据此收紧移动止盈线的回撤比例。
 *
 * 规则：
 * - 取最近两个有效交易日的收盘价与成交量，用 changePct 计算价格变动百分比与成交量变动百分比（需求 8.1）。
 * - 量价背离判定：价格变动 > 0% 且成交量变动 < -20% → `divergence = true`（需求 8.2）。
 * - `divergence = true` 时 `retreat_ratio = max(baseRatio - 0.02, 0)`；否则 `retreat_ratio = baseRatio`（需求 8.3）。
 * - 有效交易日不足 2 个、或最近两日任一成交量缺失/无效（含前一日成交量为 0 无法计算变动）时：
 *   `volume_confirm_executed = false`、`divergence = false` 且 `retreat_ratio = baseRatio` 保持不变（需求 8.4）。
 *
 * @param baseRatio 需求 6 评分定档得到的初始回撤比例（如 0.08 或 0.05）
 * @param bars 历史日线行情（升序），内部会过滤为有效交易日
 */
export function tightenRetreatRatio(
  baseRatio: number,
  bars: DailyBar[]
): VolumeConfirmResult {
  // 过滤有效交易日（open/high/low/close/vol 均有效且 close > 0，含成交量缺失/无效的剔除，需求 2.3、8.4）
  const valid = validBars(bars);

  // 有效交易日不足 2 个：跳过量价背离判定，保留基础回撤比例（需求 8.4）
  if (valid.length < 2) {
    return {
      retreat_ratio: baseRatio,
      divergence: false,
      volume_confirm_executed: false,
    };
  }

  const recent = valid[valid.length - 1]!;
  const prev = valid[valid.length - 2]!;

  // 前一日成交量为 0 时无法计算成交量变动百分比（除零），视为成交量不可用（需求 8.4）
  if (prev.vol === 0) {
    return {
      retreat_ratio: baseRatio,
      divergence: false,
      volume_confirm_executed: false,
    };
  }

  // 分别计算价格变动百分比与成交量变动百分比（需求 8.1）
  const priceChangePct = changePct(recent.close, prev.close);
  const volumeChangePct = changePct(recent.vol, prev.vol);

  // 量价背离：价格上涨但成交量显著萎缩（放量不足，需求 8.2）
  const divergence = priceChangePct > 0 && volumeChangePct < -20;

  // 背离时收紧回撤比例 0.02，下限 0；否则保持不变（需求 8.3）
  const retreat_ratio = divergence ? Math.max(baseRatio - 0.02, 0) : baseRatio;

  return {
    retreat_ratio,
    divergence,
    volume_confirm_executed: true,
  };
}
