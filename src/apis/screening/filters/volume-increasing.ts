// 需求 6：成交量递增分级判定
// 依据升序历史成交量序列（末位为基准日）取最近 3 条，
// 判定该股票是否保留，并给出"理想条件"（严格递增）或"放宽条件"（非严格递增）分级。
// 分级互斥性由 if / else if 控制流保证：命中理想分支后不再进入放宽分支。

import type { FilterDecision } from "../types";

/**
 * 成交量递增分级判定。
 *
 * 规则（需求 6.2–6.5）：
 * - 序列不足 3 条，或最近 3 条中存在缺失（null/undefined）或 ≤0 的值 → 排除并记录（需求 6.5）
 * - 最近 3 条严格递增（v1 < v2 < v3）→ 保留，仅标"理想条件"（需求 6.2）
 * - 最近 3 条非严格递增（v1 <= v2 <= v3，但非严格）→ 保留，仅标"放宽条件"（需求 6.3）
 * - 其余情况（未递增）→ 排除（需求 6.4）
 *
 * @param recent 升序历史成交量序列（末位为基准日）
 * @returns 筛选决策：保留（含分级）或排除（含原因）
 */
export function classifyVolume(recent: number[]): FilterDecision {
  // 数据不足或含非法值（缺失/≤0）→ 排除并记录（需求 6.5）
  if (recent.length < 3 || recent.some((v) => v == null || !(v > 0))) {
    return { keep: false, reason: "成交量数据不足或含非法值" };
  }

  // 取最近 3 条（末位为基准日）；上方已校验 length>=3，故三项必然存在
  const [v1, v2, v3] = recent.slice(-3) as [number, number, number];

  // 严格递增 → 仅"理想条件"（需求 6.2）
  if (v1 < v2 && v2 < v3) {
    return { keep: true, grade: "理想条件" };
  }

  // 非严格递增（含相等）→ 仅"放宽条件"（需求 6.3）
  if (v1 <= v2 && v2 <= v3) {
    return { keep: true, grade: "放宽条件" };
  }

  // 未递增 → 排除（需求 6.4）
  return { keep: false, reason: "成交量未递增" };
}
