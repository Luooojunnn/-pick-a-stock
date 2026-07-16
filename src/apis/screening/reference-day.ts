// 基准日探测（reference-day.ts）
// 对应 design.md「基准日探测（reference-day.ts）」章节，以及需求 1.5、1.7。
//
// 策略：
// - 从当前自然日开始，若当前时间未过当日 15:00 收盘时刻，则起始探测日前推一日（需求 1.5）。
// - 使用 trade_cal（exchange=SSE，is_open=1）获取真实交易日历，避免把周末/节假日
//   计入回溯计数（需求 1.5）。
// - 从起始探测日起按交易日降序逐个探测：daily 与 daily_basic 均非空即为基准日。
// - 回溯上限为 7 个交易日；超限仍无满足条件者，抛出 kind='no-reference-day' 的
//   ScreeningError（需求 1.7）。
//
// 注意：本模块经由 data-source 层的取数封装（fetchWithPolicy / fetchDailyByDate /
// fetchDailyBasicByDate）取数，从而 data-source 的 __setCallTushare mock 可覆盖本模块。

import { ScreeningError } from "./types";
import {
  fetchWithPolicy,
  fetchDailyByDate,
  fetchDailyBasicByDate,
} from "./data-source";

/** trade_cal 交易日历行 */
interface TradeCalRow {
  cal_date: string; // 交易日 YYYYMMDD
  is_open: number; // 是否开市：1 开市，0 休市
}

/** 收盘时刻（小时），当前自然日未过该时刻则起始探测日前推一日 */
const MARKET_CLOSE_HOUR = 15;

/**
 * 将 Date 格式化为本地时区的 YYYYMMDD。
 */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * 在 YYYYMMDD 基础上偏移若干自然日（deltaDays 可为负），返回 YYYYMMDD。
 * 使用 UTC 运算避免时区/夏令时干扰（中国无夏令时）。
 */
function shiftDate(yyyymmdd: string, deltaDays: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * 探测并返回基准日（Reference_Trading_Day），YYYYMMDD。
 *
 * @param maxLookback 回溯上限（交易日数），默认 7（需求 1.5、1.7）
 * @returns 基准日 YYYYMMDD
 * @throws ScreeningError kind='no-reference-day' 当回溯上限内无可用基准日（需求 1.7）
 */
export async function resolveReferenceDay(maxLookback = 7): Promise<string> {
  const now = new Date();
  let startDate = formatDate(now);

  // 当前时间未过当日 15:00：当日数据尚未入库，起始探测日前推一日（需求 1.5）
  if (now.getHours() < MARKET_CLOSE_HOUR) {
    startDate = shiftDate(startDate, -1);
  }

  // 取交易日历：窗口向前取 60 个自然日，足以覆盖 7 个交易日 + 节假日冗余
  const windowStart = shiftDate(startDate, -60);
  const calRows = await fetchWithPolicy<TradeCalRow>(
    "trade_cal",
    { exchange: "SSE", is_open: "1", start_date: windowStart, end_date: startDate },
    "cal_date,is_open"
  );

  // 仅保留开市日且 cal_date <= 起始探测日，按日期降序排列
  const tradingDays = calRows
    .filter((r) => Number(r.is_open) === 1 && r.cal_date <= startDate)
    .map((r) => r.cal_date)
    .sort((a, b) => b.localeCompare(a));

  // 回溯上限：仅探测最近 maxLookback 个交易日
  const candidates = tradingDays.slice(0, maxLookback);

  for (const day of candidates) {
    // 轻量探针：daily 为空则该日尚无数据，继续回溯
    const daily = await fetchDailyByDate(day);
    if (daily.length === 0) continue;

    // daily 非空后再探测 daily_basic，二者均非空方为基准日
    const basic = await fetchDailyBasicByDate(day);
    if (basic.length === 0) continue;

    return day;
  }

  // 回溯上限内仍无满足条件的交易日（需求 1.7）
  throw new ScreeningError(
    `回溯 ${maxLookback} 个交易日后仍无可用基准日`,
    undefined,
    "no-reference-day"
  );
}
