// 本地库查询层（repository.ts）
//
// 职责：把本地 sqlite 里的原始行，转成因子层可直接使用的领域数据。
// 因子层不接触 SQL，也不接触 Tushare，实现「数据与策略解耦」。
//
// 两条硬约束在本层强制执行：
//
// 1. 禁止未来函数。所有查询都必须带 asOfDate，只返回 trade_date <= asOfDate 的数据。
//    因子层拿不到未来数据，因此「指定历史日期运行选股」与「实盘当日运行」走的是同一条代码路径。
//
// 2. 复权价在本层算好。daily 是不复权价，跨越除权除息日直接比较会失真；
//    长周期收益率（RS）、52 周新高等计算必须用复权价。
//    复权价 = close × adj_factor，同一股票内部可比即可，不需要绝对值有意义。
//    展示价与止损价仍用原始 close，两者在 Bar 结构里分开存放。

import type { Database } from "bun:sqlite";
import { CanSlimError } from "./types";
import type { StockBasicRow, DailyBasicRow, IndexDailyRow } from "./types";

/**
 * 复权后的日线 K 线。
 *
 * close 为原始不复权收盘价（用于展示、止损价计算）；
 * adjClose / adjHigh / adjLow 为复权价（用于收益率、新高、均线等跨期计算）。
 */
export interface Bar {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  pct_chg: number;
  vol: number; // 成交量（手）
  amount: number; // 成交额（千元）
  adjFactor: number;
  adjClose: number;
  adjHigh: number;
  adjLow: number;
}

/** 某交易日的全市场截面行（daily + daily_basic 合并，daily_basic 可能缺失） */
export interface CrossSectionRow {
  ts_code: string;
  trade_date: string;
  close: number;
  pct_chg: number;
  vol: number;
  amount: number;
  adjClose: number;
  /** daily_basic 部分，缺失时为 null（例如该日 daily_basic 尚未同步） */
  basic: DailyBasicRow | null;
}

/** 把 daily + adj_factor 的联表结果映射为 Bar */
interface RawJoinedRow {
  ts_code: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  pre_close: number | null;
  pct_chg: number | null;
  vol: number | null;
  amount: number | null;
  adj_factor: number | null;
}

/** 数值兜底：null/undefined 取 0 */
function n(v: number | null | undefined): number {
  return v === null || v === undefined || !Number.isFinite(v) ? 0 : v;
}

/**
 * 复权因子兜底为 1。
 *
 * adj_factor 缺失（未同步或接口漏数据）时退化为不复权价，
 * 好处是不至于让整只股票的计算直接失效；代价是跨除权日的收益率会失真。
 * 因子层可通过 hasAdjFactor 判断是否需要降级处理。
 */
function adj(v: number | null | undefined): number {
  const x = n(v);
  return x > 0 ? x : 1;
}

function toBar(r: RawJoinedRow): Bar {
  const factor = adj(r.adj_factor);
  const close = n(r.close);
  return {
    ts_code: r.ts_code,
    trade_date: r.trade_date,
    open: n(r.open),
    high: n(r.high),
    low: n(r.low),
    close,
    pre_close: n(r.pre_close),
    pct_chg: n(r.pct_chg),
    vol: n(r.vol),
    amount: n(r.amount),
    adjFactor: factor,
    adjClose: close * factor,
    adjHigh: n(r.high) * factor,
    adjLow: n(r.low) * factor,
  };
}

// ===== 交易日 =====

/**
 * 取 [from, to] 区间内的交易日（升序）。
 * 数据来源是本地库的 trade_cal 表，只含 is_open = 1 的日期。
 */
export function getTradeDates(db: Database, from: string, to: string): string[] {
  const rows = db
    .query<{ cal_date: string }, [string, string]>(
      `SELECT cal_date FROM trade_cal
       WHERE is_open = 1 AND cal_date >= ? AND cal_date <= ?
       ORDER BY cal_date ASC`
    )
    .all(from, to);
  return rows.map((r) => r.cal_date);
}

/**
 * 把任意日期解析为「不晚于该日期、且本地库确实有行情数据」的最近交易日。
 *
 * 用途：用户传入 20260913（周日）或传入当天但盘后数据尚未同步时，
 * 自动回退到最近一个可用交易日，而不是返回空结果。
 *
 * @returns 可用的基准日；本地库在该日期之前完全没有数据时返回 null
 */
export function resolveAsOfTradeDate(db: Database, date: string): string | null {
  const row = db
    .query<{ trade_date: string }, [string]>(
      `SELECT MAX(trade_date) AS trade_date FROM daily WHERE trade_date <= ?`
    )
    .get(date);
  return row?.trade_date ?? null;
}

/**
 * 取基准日往前数第 n 个交易日（n=0 即基准日本身）。
 * 以本地库实际有数据的交易日为准，而非日历日。
 *
 * @returns 对应交易日；本地库历史不足时返回 null
 */
export function getTradeDateOffset(
  db: Database,
  asOfDate: string,
  n: number
): string | null {
  const row = db
    .query<{ trade_date: string }, [string, number]>(
      `SELECT DISTINCT trade_date FROM daily
       WHERE trade_date <= ?
       ORDER BY trade_date DESC
       LIMIT 1 OFFSET ?`
    )
    .get(asOfDate, n);
  return row?.trade_date ?? null;
}

/** 取本地库中不晚于基准日的全部交易日（降序），供批量定位偏移点使用 */
export function getRecentTradeDates(
  db: Database,
  asOfDate: string,
  limit: number
): string[] {
  const rows = db
    .query<{ trade_date: string }, [string, number]>(
      `SELECT DISTINCT trade_date FROM daily
       WHERE trade_date <= ?
       ORDER BY trade_date DESC
       LIMIT ?`
    )
    .all(asOfDate, limit);
  return rows.map((r) => r.trade_date);
}

// ===== 个股行情 =====

/**
 * 取单只股票的复权 K 线序列（升序）。
 *
 * @param asOfDate 基准日，强制 trade_date <= asOfDate（防未来函数）
 * @param from 起始日；省略则不限下界
 */
export function getAdjustedBars(
  db: Database,
  tsCode: string,
  asOfDate: string,
  from?: string
): Bar[] {
  const sql =
    `SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.pre_close,
            d.pct_chg, d.vol, d.amount, a.adj_factor
     FROM daily d
     LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
     WHERE d.ts_code = ? AND d.trade_date <= ?` +
    (from ? ` AND d.trade_date >= ?` : "") +
    ` ORDER BY d.trade_date ASC`;

  const rows = from
    ? db.query<RawJoinedRow, [string, string, string]>(sql).all(tsCode, asOfDate, from)
    : db.query<RawJoinedRow, [string, string]>(sql).all(tsCode, asOfDate);

  return rows.map(toBar);
}

/**
 * 取单只股票最近 n 根复权 K 线（升序返回，末位为最接近基准日的一根）。
 * 用于「最近 250 个交易日」这类以根数而非日期界定的窗口。
 */
export function getRecentBars(
  db: Database,
  tsCode: string,
  asOfDate: string,
  n: number
): Bar[] {
  const rows = db
    .query<RawJoinedRow, [string, string, number]>(
      `SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.pre_close,
              d.pct_chg, d.vol, d.amount, a.adj_factor
       FROM daily d
       LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
       WHERE d.ts_code = ? AND d.trade_date <= ?
       ORDER BY d.trade_date DESC
       LIMIT ?`
    )
    .all(tsCode, asOfDate, n);
  // SQL 取的是倒序，反转为升序，保持「末位最新」的统一约定
  return rows.reverse().map(toBar);
}

/**
 * 批量取多只股票最近 n 根复权 K 线。
 *
 * 一次 SQL 拉回全部候选的窗口数据，再在内存里按 ts_code 分组，
 * 避免逐只查询带来的大量往返。窗口以「基准日往前第 n 个交易日」界定，
 * 因为停牌股在区间内缺行，按日期界定比按行数界定更简单且足够。
 *
 * @returns Map：ts_code -> 升序 Bar[]
 */
export function getBarsForCodes(
  db: Database,
  tsCodes: string[],
  asOfDate: string,
  windowSize: number
): Map<string, Bar[]> {
  const result = new Map<string, Bar[]>();
  if (tsCodes.length === 0) return result;

  // 窗口起点：基准日往前第 (windowSize - 1) 个交易日；历史不足时取库内最早日期
  const startDate =
    getTradeDateOffset(db, asOfDate, windowSize - 1) ??
    db.query<{ d: string | null }, []>("SELECT MIN(trade_date) AS d FROM daily").get()?.d ??
    "00000000";

  // SQLite 参数数量有上限（默认 32766），分批查询
  const BATCH = 800;
  for (let i = 0; i < tsCodes.length; i += BATCH) {
    const batch = tsCodes.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query<RawJoinedRow, (string | number)[]>(
        `SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.pre_close,
                d.pct_chg, d.vol, d.amount, a.adj_factor
         FROM daily d
         LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
         WHERE d.ts_code IN (${placeholders})
           AND d.trade_date >= ? AND d.trade_date <= ?
         ORDER BY d.ts_code ASC, d.trade_date ASC`
      )
      .all(...batch, startDate, asOfDate);

    for (const r of rows) {
      const bar = toBar(r);
      const list = result.get(bar.ts_code);
      if (list) list.push(bar);
      else result.set(bar.ts_code, [bar]);
    }
  }

  return result;
}

// ===== 全市场截面 =====

/**
 * 取某交易日的全市场截面（daily 左联 daily_basic + adj_factor）。
 * daily 有行才会出现在结果中，因此停牌股天然被排除。
 */
export function getCrossSection(db: Database, tradeDate: string): CrossSectionRow[] {
  const rows = db
    .query<
      RawJoinedRow & {
        b_close: number | null;
        turnover_rate: number | null;
        turnover_rate_f: number | null;
        volume_ratio: number | null;
        float_share: number | null;
        free_share: number | null;
        circ_mv: number | null;
        total_mv: number | null;
        limit_status: number | null;
        has_basic: number;
      },
      [string]
    >(
      `SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.pre_close,
              d.pct_chg, d.vol, d.amount, a.adj_factor,
              b.close AS b_close, b.turnover_rate, b.turnover_rate_f, b.volume_ratio,
              b.float_share, b.free_share, b.circ_mv, b.total_mv, b.limit_status,
              CASE WHEN b.ts_code IS NULL THEN 0 ELSE 1 END AS has_basic
       FROM daily d
       LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
       LEFT JOIN daily_basic b ON b.ts_code = d.ts_code AND b.trade_date = d.trade_date
       WHERE d.trade_date = ?`
    )
    .all(tradeDate);

  return rows.map((r) => {
    const factor = adj(r.adj_factor);
    const close = n(r.close);
    return {
      ts_code: r.ts_code,
      trade_date: r.trade_date,
      close,
      pct_chg: n(r.pct_chg),
      vol: n(r.vol),
      amount: n(r.amount),
      adjClose: close * factor,
      basic:
        r.has_basic === 1
          ? {
              ts_code: r.ts_code,
              trade_date: r.trade_date,
              close: n(r.b_close),
              turnover_rate: n(r.turnover_rate),
              turnover_rate_f: n(r.turnover_rate_f),
              volume_ratio: n(r.volume_ratio),
              float_share: n(r.float_share),
              free_share: n(r.free_share),
              circ_mv: n(r.circ_mv),
              total_mv: n(r.total_mv),
              limit_status: r.limit_status,
            }
          : null,
    };
  });
}

/**
 * 取某交易日全市场的复权收盘价映射（ts_code -> adjClose）。
 * RS 计算需要在多个截面日之间比价，这是最省内存的形状。
 */
export function getAdjCloseMap(db: Database, tradeDate: string): Map<string, number> {
  const rows = db
    .query<{ ts_code: string; close: number | null; adj_factor: number | null }, [string]>(
      `SELECT d.ts_code, d.close, a.adj_factor
       FROM daily d
       LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
       WHERE d.trade_date = ?`
    )
    .all(tradeDate);

  const map = new Map<string, number>();
  for (const r of rows) {
    const price = n(r.close) * adj(r.adj_factor);
    if (price > 0) map.set(r.ts_code, price);
  }
  return map;
}

/** 取某交易日的 daily_basic 截面，按 ts_code 建索引 */
export function getDailyBasicMap(
  db: Database,
  tradeDate: string
): Map<string, DailyBasicRow> {
  const rows = db
    .query<DailyBasicRow, [string]>(
      `SELECT ts_code, trade_date, close, turnover_rate, turnover_rate_f, volume_ratio,
              float_share, free_share, circ_mv, total_mv, limit_status
       FROM daily_basic WHERE trade_date = ?`
    )
    .all(tradeDate);

  const map = new Map<string, DailyBasicRow>();
  for (const r of rows) map.set(r.ts_code, r);
  return map;
}

// ===== 股票基础信息 =====

/** 取全部股票基础信息 */
export function getStockBasics(db: Database): StockBasicRow[] {
  const rows = db
    .query<StockBasicRow, []>(
      `SELECT ts_code, name, industry, market, list_date FROM stock_basic`
    )
    .all();
  if (rows.length === 0) {
    throw new CanSlimError(
      "本地库 stock_basic 为空，请先执行：bun run src/scripts/sync-market-data.ts",
      undefined,
      "db"
    );
  }
  return rows;
}

/** 取股票基础信息映射（ts_code -> 行） */
export function getStockBasicMap(db: Database): Map<string, StockBasicRow> {
  const map = new Map<string, StockBasicRow>();
  for (const r of getStockBasics(db)) map.set(r.ts_code, r);
  return map;
}

// ===== 指数 =====

/**
 * 取单个指数的日线序列（升序），强制 trade_date <= asOfDate。
 *
 * @param limit 只取最近 limit 根；省略则取 from 之后的全部
 */
export function getIndexBars(
  db: Database,
  tsCode: string,
  asOfDate: string,
  limit?: number
): IndexDailyRow[] {
  if (limit !== undefined) {
    const rows = db
      .query<IndexDailyRow, [string, string, number]>(
        `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, amount
         FROM index_daily
         WHERE ts_code = ? AND trade_date <= ?
         ORDER BY trade_date DESC LIMIT ?`
      )
      .all(tsCode, asOfDate, limit);
    return rows.reverse();
  }

  return db
    .query<IndexDailyRow, [string, string]>(
      `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, amount
       FROM index_daily
       WHERE ts_code = ? AND trade_date <= ?
       ORDER BY trade_date ASC`
    )
    .all(tsCode, asOfDate);
}

// ===== 派生工具 =====

/**
 * 计算某只股票在基准日之前的可交易天数（本地库中的行数）。
 * 用于「上市不足 250 个交易日 → N/L 因子降级」判定。
 */
export function countBars(db: Database, tsCode: string, asOfDate: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(1) AS n FROM daily WHERE ts_code = ? AND trade_date <= ?`
    )
    .get(tsCode, asOfDate);
  return row?.n ?? 0;
}

/** 批量统计多只股票的可交易天数（ts_code -> 行数） */
export function countBarsForCodes(
  db: Database,
  tsCodes: string[],
  asOfDate: string
): Map<string, number> {
  const result = new Map<string, number>();
  if (tsCodes.length === 0) return result;

  const BATCH = 800;
  for (let i = 0; i < tsCodes.length; i += BATCH) {
    const batch = tsCodes.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query<{ ts_code: string; n: number }, (string | number)[]>(
        `SELECT ts_code, COUNT(1) AS n FROM daily
         WHERE ts_code IN (${placeholders}) AND trade_date <= ?
         GROUP BY ts_code`
      )
      .all(...batch, asOfDate);
    for (const r of rows) result.set(r.ts_code, r.n);
  }
  return result;
}

/**
 * 简单移动平均。
 *
 * @param values 升序序列
 * @param period 周期
 * @returns 与输入等长的数组，不足周期处为 null
 */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
