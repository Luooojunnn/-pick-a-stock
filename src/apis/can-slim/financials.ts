// 财务与股东数据的取数 + 缓存 + 查询层（financials.ts）
//
// 这一层解决三件事：
//
// 1. 成本控制。fina_indicator / top10_floatholders 只能按单只股票取数，
//    5000 只全市场逐只拉必然撞频控。因此这些接口只对「已通过截面筛选的候选」调用，
//    并把结果落入本地库，配合 fetch_log 做到「同一只股票一周内只拉一次」。
//
// 2. 无未来函数。财务数据的报告期（end_date）与可见时点（ann_date）是两个概念：
//    2026-03-31 的季报可能到 2026-04-28 才公布。回测在 2026-04-01 运行时
//    绝不能看到这份数据。所有查询都按 ann_date <= asOfDate 过滤。
//
// 3. 版本去重。Tushare 对同一报告期可能多次发布（更正、补充披露），
//    表里按 (ts_code, end_date, ann_date) 保留全部版本，
//    查询时对每个 end_date 只取「在基准日之前可见的最新一版」。
//    实测确认这不是理论问题：300750.SZ 的 20230630、20230331 都存在重复行。

import type { Database } from "bun:sqlite";
import { upsertRows, filterUnfetched, markFetched } from "./db";
import {
  fetchFinaIndicator,
  fetchTop10FloatHolders,
  fetchHolderNumbers,
} from "./data-source";
import type {
  FinaIndicatorRow,
  Top10FloatHolderRow,
  HolderNumberRow,
} from "./data-source";
import { CanSlimError } from "./types";

/** 财务数据回溯年数：3 年 EPS CAGR 需要 4 个年报，留一年余量 */
const FINANCIAL_LOOKBACK_YEARS = 5;

/** 批量取数的并发度。逐只接口按小批并发，兼顾速度与频控 */
const FETCH_CONCURRENCY = 5;

/** 缓存有效期（天）。财务数据按季度更新，一周内重复拉取没有意义 */
const CACHE_MAX_AGE_DAYS = 7;

const FINA_COLUMNS = [
  "ts_code",
  "end_date",
  "ann_date",
  "eps",
  "dt_eps",
  "profit_dedt",
  "roe",
  "roe_waa",
  "roe_dt",
  "grossprofit_margin",
  "netprofit_margin",
  "basic_eps_yoy",
  "dt_netprofit_yoy",
  "netprofit_yoy",
  "or_yoy",
  "tr_yoy",
  "q_eps",
  "q_dtprofit",
  "q_sales_yoy",
  "q_netprofit_yoy",
  "q_profit_yoy",
  "q_gr_yoy",
  "q_dt_roe",
  "debt_to_assets",
  "update_flag",
];

const TOP10_COLUMNS = [
  "ts_code",
  "end_date",
  "ann_date",
  "holder_name",
  "hold_amount",
  "hold_ratio",
  "hold_float_ratio",
  "hold_change",
  "holder_type",
];

/** 取数结果统计 */
export interface EnsureResult {
  /** 本次实际发起在线调用的股票数 */
  fetched: number;
  /** 命中本地缓存、跳过调用的股票数 */
  cached: number;
  /** 取数失败的股票数（失败不中断整体） */
  failed: number;
  /** 是否因权限不足而整体放弃（触发因子降级） */
  permissionDenied: boolean;
  /** 首个错误信息，用于降级说明 */
  firstError?: string;
}

/** 在 YYYYMMDD 上前推若干年 */
function subtractYears(ymd: string, years: number): string {
  const y = Number(ymd.slice(0, 4)) - years;
  return `${y}${ymd.slice(4)}`;
}

/** 分批并发执行，返回每项的成功/失败 */
async function inBatches<T, R>(
  items: T[],
  batchSize: number,
  handler: (item: T) => Promise<R>
): Promise<{ ok: R[]; errors: unknown[] }> {
  const ok: R[] = [];
  const errors: unknown[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(handler));
    for (const s of settled) {
      if (s.status === "fulfilled") ok.push(s.value);
      else errors.push(s.reason);
    }
    // 权限类错误没有重试价值，出现即提前结束，避免把剩余候选全跑一遍
    if (errors.some((e) => e instanceof CanSlimError && e.kind === "permission")) {
      break;
    }
  }
  return { ok, errors };
}

/**
 * 确保候选股的财务指标已在本地库中。
 *
 * @param tsCodes 候选股代码
 * @param asOfDate 基准日
 * @param onProgress 进度回调（已完成数, 总数）
 */
export async function ensureFinaIndicators(
  db: Database,
  tsCodes: string[],
  asOfDate: string,
  onProgress?: (done: number, total: number) => void
): Promise<EnsureResult> {
  const startDate = subtractYears(asOfDate, FINANCIAL_LOOKBACK_YEARS);
  const pending = filterUnfetched(db, "fina_indicator", tsCodes, CACHE_MAX_AGE_DAYS);
  const cached = tsCodes.length - pending.length;

  if (pending.length === 0) {
    return { fetched: 0, cached, failed: 0, permissionDenied: false };
  }

  let done = 0;
  const { errors } = await inBatches(pending, FETCH_CONCURRENCY, async (code) => {
    const rows = await fetchFinaIndicator(code, startDate, asOfDate);
    // 落库前过滤掉 ann_date 为空的行：没有可见时点就无法做无未来函数判定
    const usable = rows.filter((r) => r.ann_date !== "");
    if (usable.length > 0) {
      upsertRows(db, "fina_indicator", FINA_COLUMNS, usable as unknown as Record<string, unknown>[], [
        "ts_code",
        "end_date",
        "ann_date",
      ]);
    }
    markFetched(db, "fina_indicator", code, usable.length);
    done++;
    if (onProgress && done % 20 === 0) onProgress(done, pending.length);
    return usable.length;
  });

  const permissionDenied = errors.some(
    (e) => e instanceof CanSlimError && e.kind === "permission"
  );
  const firstError =
    errors.length > 0
      ? errors[0] instanceof Error
        ? (errors[0] as Error).message
        : String(errors[0])
      : undefined;

  return {
    fetched: done,
    cached,
    failed: errors.length,
    permissionDenied,
    firstError,
  };
}

/**
 * 读取某只股票在基准日之前「可见」的财务报告期序列。
 *
 * 处理两个关键点：
 * - 只保留 ann_date <= asOfDate 的行（无未来函数）
 * - 同一 end_date 多版本时，取 ann_date 最晚的那版（最新更正）
 *
 * @returns 按 end_date 降序（最新报告期在前）
 */
export function getVisibleFinaIndicators(
  db: Database,
  tsCode: string,
  asOfDate: string
): FinaIndicatorRow[] {
  const rows = db
    .query<FinaIndicatorRow, [string, string]>(
      `SELECT ${FINA_COLUMNS.join(", ")} FROM fina_indicator
       WHERE ts_code = ? AND ann_date <= ? AND ann_date != ''
       ORDER BY end_date DESC, ann_date DESC`
    )
    .all(tsCode, asOfDate);

  // 同一 end_date 只保留首条（已按 ann_date 降序，首条即最新版本）
  const seen = new Set<string>();
  const deduped: FinaIndicatorRow[] = [];
  for (const r of rows) {
    if (seen.has(r.end_date)) continue;
    seen.add(r.end_date);
    deduped.push(r);
  }
  return deduped;
}

/** 批量读取多只股票的可见财务序列 */
export function getVisibleFinaIndicatorsForCodes(
  db: Database,
  tsCodes: string[],
  asOfDate: string
): Map<string, FinaIndicatorRow[]> {
  const result = new Map<string, FinaIndicatorRow[]>();
  if (tsCodes.length === 0) return result;

  const BATCH = 500;
  for (let i = 0; i < tsCodes.length; i += BATCH) {
    const batch = tsCodes.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query<FinaIndicatorRow, string[]>(
        `SELECT ${FINA_COLUMNS.join(", ")} FROM fina_indicator
         WHERE ts_code IN (${placeholders}) AND ann_date <= ? AND ann_date != ''
         ORDER BY ts_code ASC, end_date DESC, ann_date DESC`
      )
      .all(...batch, asOfDate);

    // 按 ts_code 分组，并对每组内的同 end_date 去重
    const seenPerCode = new Map<string, Set<string>>();
    for (const r of rows) {
      let seen = seenPerCode.get(r.ts_code);
      if (!seen) {
        seen = new Set<string>();
        seenPerCode.set(r.ts_code, seen);
      }
      if (seen.has(r.end_date)) continue;
      seen.add(r.end_date);

      const list = result.get(r.ts_code);
      if (list) list.push(r);
      else result.set(r.ts_code, [r]);
    }
  }
  return result;
}

/**
 * 确保候选股的前十大流通股东数据已在本地库中。
 * 只取最近两年，足够判断「最近两个季度是否连续增持」。
 */
export async function ensureTop10FloatHolders(
  db: Database,
  tsCodes: string[],
  asOfDate: string,
  onProgress?: (done: number, total: number) => void
): Promise<EnsureResult> {
  const startDate = subtractYears(asOfDate, 2);
  const pending = filterUnfetched(db, "top10_floatholders", tsCodes, CACHE_MAX_AGE_DAYS);
  const cached = tsCodes.length - pending.length;

  if (pending.length === 0) {
    return { fetched: 0, cached, failed: 0, permissionDenied: false };
  }

  let done = 0;
  const { errors } = await inBatches(pending, FETCH_CONCURRENCY, async (code) => {
    const rows = await fetchTop10FloatHolders(code, startDate, asOfDate);
    if (rows.length > 0) {
      upsertRows(
        db,
        "top10_floatholders",
        TOP10_COLUMNS,
        rows as unknown as Record<string, unknown>[],
        ["ts_code", "end_date", "holder_name"]
      );
    }
    markFetched(db, "top10_floatholders", code, rows.length);
    done++;
    if (onProgress && done % 20 === 0) onProgress(done, pending.length);
    return rows.length;
  });

  const permissionDenied = errors.some(
    (e) => e instanceof CanSlimError && e.kind === "permission"
  );
  return {
    fetched: done,
    cached,
    failed: errors.length,
    permissionDenied,
    firstError:
      errors.length > 0
        ? errors[0] instanceof Error
          ? (errors[0] as Error).message
          : String(errors[0])
        : undefined,
  };
}

/**
 * 读取某只股票在基准日之前可见的前十大流通股东，按报告期分组。
 * @returns Map：end_date -> 股东列表（按报告期降序遍历时用 sortedEndDates）
 */
export function getVisibleTop10Holders(
  db: Database,
  tsCode: string,
  asOfDate: string
): Map<string, Top10FloatHolderRow[]> {
  const rows = db
    .query<Top10FloatHolderRow, [string, string]>(
      `SELECT ${TOP10_COLUMNS.join(", ")} FROM top10_floatholders
       WHERE ts_code = ? AND (ann_date IS NULL OR ann_date = '' OR ann_date <= ?)
       ORDER BY end_date DESC`
    )
    .all(tsCode, asOfDate);

  const byPeriod = new Map<string, Top10FloatHolderRow[]>();
  for (const r of rows) {
    // ann_date 缺失的行无法确认可见时点，保守跳过
    if (!r.ann_date) continue;
    const list = byPeriod.get(r.end_date);
    if (list) list.push(r);
    else byPeriod.set(r.end_date, [r]);
  }
  return byPeriod;
}

/**
 * 确保股东户数数据已在本地库中。
 *
 * 该接口支持按公告日期批量拉全市场，但实测宽区间会被截断
 * （20260401~20260910 只返回 5500 行、覆盖 1288 只），
 * 因此按月分段拉取：每段窗口窄，返回行数远低于单次上限，可覆盖全市场。
 *
 * @param months 回溯月数，默认 15 个月（覆盖最近 4~5 个披露期，够算环比）
 */
export async function ensureHolderNumbers(
  db: Database,
  asOfDate: string,
  months = 15
): Promise<EnsureResult> {
  const windows = buildMonthlyWindows(asOfDate, months);
  const pending = windows.filter(
    (w) => filterUnfetched(db, "stk_holdernumber", [w.key], CACHE_MAX_AGE_DAYS).length > 0
  );
  const cached = windows.length - pending.length;

  if (pending.length === 0) {
    return { fetched: 0, cached, failed: 0, permissionDenied: false };
  }

  let fetched = 0;
  const errors: unknown[] = [];

  for (const w of pending) {
    try {
      const rows = await fetchHolderNumbers(w.start, w.end);
      const usable = rows.filter((r) => r.ts_code && r.end_date);
      if (usable.length > 0) {
        upsertRows(
          db,
          "stk_holdernumber",
          ["ts_code", "end_date", "ann_date", "holder_num"],
          usable as unknown as Record<string, unknown>[],
          ["ts_code", "end_date"]
        );
      }
      markFetched(db, "stk_holdernumber", w.key, usable.length);
      fetched++;
    } catch (err) {
      errors.push(err);
      if (err instanceof CanSlimError && err.kind === "permission") break;
    }
  }

  return {
    fetched,
    cached,
    failed: errors.length,
    permissionDenied: errors.some((e) => e instanceof CanSlimError && e.kind === "permission"),
    firstError:
      errors.length > 0
        ? errors[0] instanceof Error
          ? (errors[0] as Error).message
          : String(errors[0])
        : undefined,
  };
}

/** 构造按月切分的公告日期窗口（倒序，最近的月份在前） */
function buildMonthlyWindows(
  asOfDate: string,
  months: number
): { key: string; start: string; end: string }[] {
  const year = Number(asOfDate.slice(0, 4));
  const month = Number(asOfDate.slice(4, 6));
  const windows: { key: string; start: string; end: string }[] = [];

  for (let i = 0; i < months; i++) {
    // 从基准月往前推 i 个月
    const totalMonths = year * 12 + (month - 1) - i;
    const y = Math.floor(totalMonths / 12);
    const m = (totalMonths % 12) + 1;
    const mm = String(m).padStart(2, "0");
    // 该月最后一天：下个月 1 日减 1 天
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const start = `${y}${mm}01`;
    const end = `${y}${mm}${String(lastDay).padStart(2, "0")}`;
    windows.push({ key: `${y}${mm}`, start, end: end > asOfDate ? asOfDate : end });
  }
  return windows;
}

/**
 * 读取某只股票在基准日之前可见的股东户数序列（按截止日期降序）。
 */
export function getVisibleHolderNumbers(
  db: Database,
  tsCode: string,
  asOfDate: string
): HolderNumberRow[] {
  return db
    .query<HolderNumberRow, [string, string]>(
      `SELECT ts_code, end_date, ann_date, holder_num FROM stk_holdernumber
       WHERE ts_code = ? AND ann_date IS NOT NULL AND ann_date != '' AND ann_date <= ?
       ORDER BY end_date DESC`
    )
    .all(tsCode, asOfDate);
}

/** 批量读取股东户数序列 */
export function getVisibleHolderNumbersForCodes(
  db: Database,
  tsCodes: string[],
  asOfDate: string
): Map<string, HolderNumberRow[]> {
  const result = new Map<string, HolderNumberRow[]>();
  if (tsCodes.length === 0) return result;

  const BATCH = 500;
  for (let i = 0; i < tsCodes.length; i += BATCH) {
    const batch = tsCodes.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query<HolderNumberRow, string[]>(
        `SELECT ts_code, end_date, ann_date, holder_num FROM stk_holdernumber
         WHERE ts_code IN (${placeholders})
           AND ann_date IS NOT NULL AND ann_date != '' AND ann_date <= ?
         ORDER BY ts_code ASC, end_date DESC`
      )
      .all(...batch, asOfDate);

    for (const r of rows) {
      const list = result.get(r.ts_code);
      if (list) list.push(r);
      else result.set(r.ts_code, [r]);
    }
  }
  return result;
}
