// 量比筛选（需求 3）
// 判定基准日 daily_basic 的 volume_ratio 是否满足 ≥ 1（含端点 1）。
// 无效值（缺字段、null、NaN、非数值等）一律排除并返回排除原因，由调用方记录。
// 对应 design.md Property 4：量比阈值筛选（含端点 1）。

import type { DailyBasicRow, FilterDecision } from "../types";
import { isValidNumber } from "./common";

/** 量比阈值：≥ 1（含端点 1）保留，否则排除 */
const VOLUME_RATIO_MIN = 1;

/**
 * 量比筛选纯函数。
 * @param basic 基准日的 daily_basic 行；可能为 undefined（该股缺当日截面数据）
 * @returns FilterDecision：满足 volume_ratio ≥ 1 保留，否则/无效值排除并给出 reason
 */
export function applyVolumeRatio(basic: DailyBasicRow | undefined): FilterDecision {
  // 缺少基准日 daily_basic 数据 → 排除（需求 3.4）
  if (!basic) {
    return { keep: false, reason: "缺少基准日 daily_basic 数据" };
  }

  const value = basic.volume_ratio;

  // 无效值（缺失、null、NaN、非数值等）一律排除（需求 3.4）
  if (!isValidNumber(value)) {
    return { keep: false, reason: "量比 volume_ratio 无效或缺失" };
  }

  // volume_ratio ≥ 1（含端点 1）保留（需求 3.2）
  if (value >= VOLUME_RATIO_MIN) {
    return { keep: true };
  }

  // volume_ratio < 1 排除（需求 3.3）
  return { keep: false, reason: `量比 ${value} 小于 ${VOLUME_RATIO_MIN}` };
}
