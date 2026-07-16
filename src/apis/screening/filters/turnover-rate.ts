// 换手率筛选（需求 4）
// 判定 5 ≤ turnover_rate ≤ 10（含端点）；无效值或缺数据一律排除并给出原因。
// 本模块为纯函数：仅做判定，不涉及接口调用/超时/重试等 I/O（那些由 data-source 层负责）。

import type { DailyBasicRow, FilterDecision } from "../types";
import { inClosedRange } from "./common";

/** 换手率筛选下界（含端点，单位：%） */
const TURNOVER_RATE_MIN = 5;
/** 换手率筛选上界（含端点，单位：%） */
const TURNOVER_RATE_MAX = 10;

/**
 * 换手率筛选纯函数。
 *
 * 输入基准日的 daily_basic 行（可能 undefined，表示缺少当日数据）：
 * - 缺数据（undefined）或 turnover_rate 为无效值 → 排除并给出 reason（需求 4.4）
 * - 5 ≤ turnover_rate ≤ 10（含端点）→ 保留（需求 4.2）
 * - 区间外 → 排除（需求 4.3）
 *
 * @param row 基准日的 DailyBasicRow，或 undefined（缺数据）
 * @returns FilterDecision 保留或排除的决策
 */
export function applyTurnoverRate(
  row: DailyBasicRow | undefined
): FilterDecision {
  // 缺少基准日 daily_basic 数据：无法判定，直接排除（需求 4.4）
  if (row === undefined || row === null) {
    return { keep: false, reason: "缺少基准日 daily_basic 数据，无法判定换手率" };
  }

  const value = row.turnover_rate;

  // 无效值（缺失、null、NaN、非数值等）一律排除并记录原因（需求 4.4）
  if (!inClosedRange(value, TURNOVER_RATE_MIN, TURNOVER_RATE_MAX)) {
    // 区分「无效值」与「有效但超出区间」，便于诊断
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { keep: false, reason: "换手率无效或缺失" };
    }
    return {
      keep: false,
      reason: `换手率 ${value} 超出区间 [${TURNOVER_RATE_MIN}, ${TURNOVER_RATE_MAX}]`,
    };
  }

  // 5 ≤ turnover_rate ≤ 10（含端点）→ 保留（需求 4.2）
  return { keep: true };
}
