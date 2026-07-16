// screening 各筛选器共享的数值与区间判定工具
// 对应 design.md「关键算法与函数签名 - 区间判定」以及需求 2.4/3.4/4.4/5.4/6.5

import type { ExclusionRecord } from "../types";

/**
 * 判定 x 是否为有效数值。
 * 拒绝 null、undefined、NaN、Infinity 及一切非 number 类型（如字符串、空串）。
 */
export function isValidNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * 闭区间判定，含端点 lo 与 hi。
 * 无效值（缺失、null、NaN、非数值等）一律返回 false，由调用方据此排除并记录。
 */
export function inClosedRange(x: unknown, lo: number, hi: number): boolean {
  return isValidNumber(x) && x >= lo && x <= hi;
}

/**
 * 写入一条排除记录（ExclusionRecord）。
 * 记录本身的失败（如数组不可写等异常）不会向上抛出，
 * 以保证「即使记录失败，排除动作仍然发生」（需求 2.4/3.4/4.4/5.4/6.5）。
 */
export function recordExclusion(
  records: ExclusionRecord[],
  ts_code: string,
  filter: string,
  reason: string
): void {
  try {
    records.push({ ts_code, filter, reason });
  } catch {
    // 记录失败不影响排除流程，静默吞掉异常
  }
}
