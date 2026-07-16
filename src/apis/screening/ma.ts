// 移动平均线（MA）计算与"向上"判定工具
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）

/**
 * 计算以 endIndex 为窗口末端、长度 period 的简单移动平均（SMA）。
 * 数据不足时返回 null：
 *   - endIndex + 1 < period：从 0 到 endIndex 的元素数量不足 period 个
 *   - endIndex >= closes.length：窗口末端越界
 * 否则返回窗口内 period 个收盘价的算术平均。
 *
 * 需求 7.1
 */
export function sma(closes: number[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period || endIndex >= closes.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += closes[i]!;
  return sum / period;
}

/**
 * 均线向上判定：严格大于（today > prev）。
 * 相等或更小视为不向上；任一值为 null 时同样判为不向上。
 *
 * 需求 7.2
 */
export function isRising(today: number | null, prev: number | null): boolean {
  return today != null && prev != null && today > prev;
}
