// 指标计算模块（how-to-sell / "我的股票合适卖"）
// 纯函数模块，无 I/O，输入行情/参数，输出指标数值，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md 的 "Components and Interfaces" 第 5 节与相关需求实现。

import type { DailyBar } from "./types";

/**
 * 四舍五入保留 digits 位小数的工具函数。
 * 非有限数（NaN / Infinity）原样返回。
 * 采用先放大再四舍五入的方式，并借助极小量修正常见浮点误差
 * （如 1.005 → 1.01），使结果符合"四舍五入"的直觉预期。
 */
export function round(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const factor = 10 ** digits;
  // 乘以 (1 + EPSILON) 修正诸如 1.005 * 100 = 100.49999... 的浮点误差
  return Math.round(x * factor * (1 + Number.EPSILON)) / factor;
}

/**
 * 判断单个数值是否为有效数值：非 null / 非 undefined / 为有限数字（排除 NaN、Infinity）。
 */
function isValidNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 过滤有效交易日：open、high、low、close、vol 均为有效数值（非 null/NaN/Infinity）
 * 且 close 为大于 0 的数值的交易日，保持相对顺序（需求 2.3）。
 */
export function validBars(bars: DailyBar[]): DailyBar[] {
  return bars.filter(
    (b) =>
      b != null &&
      isValidNumber(b.open) &&
      isValidNumber(b.high) &&
      isValidNumber(b.low) &&
      isValidNumber(b.close) &&
      isValidNumber(b.vol) &&
      b.close > 0
  );
}

/**
 * 盈亏比例：(currentPrice - cost) / cost × 100，四舍五入保留 2 位小数（需求 3.1、3.2、3.3）。
 * 调用方需保证 cost > 0（cost ≤ 0 的防御分支在服务层处理）。
 */
export function profitPct(currentPrice: number, cost: number): number {
  return round(((currentPrice - cost) / cost) * 100, 2);
}

/**
 * 单日真实波幅 TR = max(high - low, |high - prevClose|, |low - prevClose|)（需求 4.2）。
 */
export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose)
  );
}

/**
 * ATR14：最近 14 个交易日 TR 的算术平均值，四舍五入保留 4 位小数（需求 4.2、4.5）。
 * 计算前先过滤有效交易日；由于每日 TR 需相邻日收盘价，可用于计算的交易日
 * 少于 15 个（14 日 TR 需 15 个连续交易日）时返回 null。
 */
export function atr14(bars: DailyBar[]): number | null {
  const valid = validBars(bars);
  // 需 15 个连续有效交易日才能得到 14 个 TR 值
  if (valid.length < 15) return null;
  const n = valid.length;
  let sum = 0;
  // 取最近 14 个交易日的 TR：索引 n-14 .. n-1，各自使用前一日收盘价
  for (let i = n - 14; i < n; i++) {
    const day = valid[i]!;
    const prev = valid[i - 1]!;
    sum += trueRange(day.high, day.low, prev.close);
  }
  return round(sum / 14, 4);
}

/**
 * 简单移动平均（SMA）：以 endIndex 为窗口末端、长度 period 的算术平均（需求 5.1）。
 * 数据不足时返回 null：
 *   - endIndex + 1 < period：从 0 到 endIndex 的元素数量不足 period 个
 *   - endIndex >= closes.length：窗口末端越界
 *   - endIndex < 0 或 period <= 0：非法窗口
 * 否则返回窗口内 period 个收盘价的算术平均。
 */
export function sma(
  closes: number[],
  period: number,
  endIndex: number
): number | null {
  if (period <= 0 || endIndex < 0) return null;
  if (endIndex + 1 < period || endIndex >= closes.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += closes[i]!;
  return sum / period;
}

/**
 * 持有期最高收盘价（需求 6.1、1.7、6.4）：
 * 提供 fromIndex 时取该索引（含）至末尾区间内的最高有效 close，
 * 未提供时取全区间内的最高有效 close；区间内无有效收盘价时返回 null。
 * 有效 close 定义为有限数值且大于 0。
 */
export function highestClose(
  bars: DailyBar[],
  fromIndex?: number
): number | null {
  const start = fromIndex == null ? 0 : Math.max(0, fromIndex);
  let max: number | null = null;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    if (b == null) continue;
    const c = b.close;
    if (isValidNumber(c) && c > 0) {
      if (max == null || c > max) max = c;
    }
  }
  return max;
}

/**
 * 变动百分比：(recent - prev) / prev × 100（需求 8.1）。
 * 调用方需保证 prev ≠ 0。
 */
export function changePct(recent: number, prev: number): number {
  return ((recent - prev) / prev) * 100;
}
