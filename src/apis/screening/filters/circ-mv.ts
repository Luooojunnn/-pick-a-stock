// 流通市值筛选（需求 5）
// 判定 500000 ≤ circ_mv ≤ 2000000（含两端端点，单位：万元）；无效值或缺数据一律排除并给出原因。
// 本模块为纯函数：仅做判定，不涉及接口调用/超时/重试等 I/O（那些由 data-source 层负责）。
// 对应 design.md Property 6：流通市值区间筛选（含端点 500000、2000000）。

import type { DailyBasicRow, FilterDecision } from "../types";
import { inClosedRange } from "./common";

/** 流通市值筛选下界（含端点，单位：万元，即 50 亿） */
const CIRC_MV_MIN = 500000;
/** 流通市值筛选上界（含端点，单位：万元，即 200 亿） */
const CIRC_MV_MAX = 2000000;

/**
 * 流通市值筛选纯函数。
 *
 * 输入基准日的 daily_basic 行（可能 undefined，表示缺少当日数据）：
 * - 缺数据（undefined/null）或 circ_mv 为无效值 → 排除并给出 reason（需求 5.4）
 * - 500000 ≤ circ_mv ≤ 2000000（含两端端点）→ 保留（需求 5.2）
 * - 区间外 → 排除（需求 5.3）
 *
 * @param row 基准日的 DailyBasicRow，或 undefined（缺数据）
 * @returns FilterDecision 保留或排除的决策
 */
export function applyCircMv(row: DailyBasicRow | undefined): FilterDecision {
  // 缺少基准日 daily_basic 数据：无法判定，直接排除（需求 5.4）
  if (row === undefined || row === null) {
    return { keep: false, reason: "缺少基准日 daily_basic 数据，无法判定流通市值" };
  }

  const value = row.circ_mv;

  // 无效值或超出区间一律不通过闭区间判定（需求 5.3、5.4）
  if (!inClosedRange(value, CIRC_MV_MIN, CIRC_MV_MAX)) {
    // 区分「无效值」与「有效但超出区间」，便于诊断
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { keep: false, reason: "流通市值无效或缺失" };
    }
    return {
      keep: false,
      reason: `流通市值 ${value} 超出区间 [${CIRC_MV_MIN}, ${CIRC_MV_MAX}]`,
    };
  }

  // 500000 ≤ circ_mv ≤ 2000000（含两端端点）→ 保留（需求 5.2）
  return { keep: true };
}
