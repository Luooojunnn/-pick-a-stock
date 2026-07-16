// 涨幅筛选（需求 2）：仅保留基准日涨幅 pct_chg 落在闭区间 [3, 5] 的股票
// 对应 design.md「筛选管线顺序设计」步骤 2 与 Property 3。

import type { DailyRow, FilterDecision } from "../types";
import { inClosedRange, isValidNumber } from "./common";

/** 涨幅下限（含端点，单位：百分比） */
const PCT_CHG_MIN = 3;
/** 涨幅上限（含端点，单位：百分比） */
const PCT_CHG_MAX = 5;

/**
 * 涨幅筛选纯函数。
 *
 * 输入基准日的 daily 行（可能为 undefined，表示该股缺少 daily 数据）：
 * - 缺少 daily 数据 → 排除（需求 2.4）
 * - pct_chg 为无效值（缺失、null、NaN、非数值等）→ 排除（需求 2.4）
 * - 3 ≤ pct_chg ≤ 5（含端点 3 与 5）→ 保留（需求 2.2）
 * - 有效数值但落在区间外 → 排除（需求 2.3）
 *
 * 返回 FilterDecision：保留 keep:true；排除 keep:false 并携带 reason（供调用方记录）。
 */
export function applyPctChg(daily: DailyRow | undefined): FilterDecision {
  // 缺少基准日 daily 数据 → 排除并说明原因（需求 2.4）
  if (daily === undefined) {
    return { keep: false, reason: "缺少基准日 daily 数据" };
  }

  const pctChg = daily.pct_chg;

  // 涨幅字段为无效值 → 排除并说明原因（需求 2.4）
  if (!isValidNumber(pctChg)) {
    return { keep: false, reason: "pct_chg 为无效值" };
  }

  // 落在闭区间 [3, 5]（含端点）→ 保留（需求 2.2）
  if (inClosedRange(pctChg, PCT_CHG_MIN, PCT_CHG_MAX)) {
    return { keep: true };
  }

  // 有效数值但在区间外 → 排除（需求 2.3）
  return {
    keep: false,
    reason: `pct_chg=${pctChg} 不在 [${PCT_CHG_MIN}, ${PCT_CHG_MAX}] 区间内`,
  };
}
