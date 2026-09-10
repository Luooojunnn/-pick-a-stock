// 本地行情库（db.ts）
//
// 使用 Bun 内置的 bun:sqlite，零额外依赖。本地库承担两件事：
// 1. 把「按交易日循环拉全市场」的行情数据落盘，使 RS、52 周新高、20 日均量等
//    需要全市场长历史的因子可以本地计算，日常只需增量同步当日数据。
// 2. 为后续回测提供可重放的历史数据基础。
//
// 设计要点：
// - 所有行情表以 (ts_code, trade_date) 为主键，写入用 UPSERT，保证同步幂等。
// - trade_date 上建索引，支撑「取某日全市场截面」这类查询。
// - sync_progress 按 (trade_date, table_name) 记录已完成的同步单元，支持断点续跑。
// - 开启 WAL 与放宽 synchronous，提升批量写入吞吐（本地缓存库，可容忍极端断电丢尾）。

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CanSlimError } from "./types";

/** 本地库默认路径（相对项目根目录；已在 .gitignore 中排除） */
export const DEFAULT_DB_PATH = "data/canslim.sqlite";

/** 建表语句：全部使用 IF NOT EXISTS，可重复执行（幂等） */
const SCHEMA_SQL = `
-- 不复权日线行情
CREATE TABLE IF NOT EXISTS daily (
  ts_code    TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  pre_close  REAL,
  pct_chg    REAL,
  vol        REAL,
  amount     REAL,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_trade_date ON daily (trade_date);

-- 复权因子
CREATE TABLE IF NOT EXISTS adj_factor (
  ts_code    TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  adj_factor REAL,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_adj_factor_trade_date ON adj_factor (trade_date);

-- 每日基本面指标
CREATE TABLE IF NOT EXISTS daily_basic (
  ts_code         TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  close           REAL,
  turnover_rate   REAL,
  turnover_rate_f REAL,
  volume_ratio    REAL,
  float_share     REAL,
  free_share      REAL,
  circ_mv         REAL,
  total_mv        REAL,
  limit_status    INTEGER,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_basic_trade_date ON daily_basic (trade_date);

-- 指数日线（M 因子）
CREATE TABLE IF NOT EXISTS index_daily (
  ts_code    TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  pct_chg    REAL,
  vol        REAL,
  amount     REAL,
  PRIMARY KEY (ts_code, trade_date)
);

-- 交易日历
CREATE TABLE IF NOT EXISTS trade_cal (
  exchange      TEXT NOT NULL,
  cal_date      TEXT NOT NULL,
  is_open       INTEGER NOT NULL,
  pretrade_date TEXT,
  PRIMARY KEY (exchange, cal_date)
);

-- 股票基础信息（每次同步全量覆盖）
CREATE TABLE IF NOT EXISTS stock_basic (
  ts_code   TEXT PRIMARY KEY,
  name      TEXT,
  industry  TEXT,
  market    TEXT,
  list_date TEXT
);

-- 同步进度：按 (交易日, 表名) 记录已完成单元，用于断点续跑
CREATE TABLE IF NOT EXISTS sync_progress (
  trade_date TEXT NOT NULL,
  table_name TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  done_at    TEXT NOT NULL,
  PRIMARY KEY (trade_date, table_name)
);

-- 键值元信息（如最后一次同步时间）
CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 财务指标（C / A 因子）
--
-- 主键含 ann_date：Tushare 对同一报告期可能多次发布（更正、补充披露），
-- 保留全部版本才能在历史回测中还原「当时能看到哪一版」。
-- 查询时按 ann_date <= 基准日过滤，再按 (ts_code, end_date) 取最新一版。
CREATE TABLE IF NOT EXISTS fina_indicator (
  ts_code            TEXT NOT NULL,
  end_date           TEXT NOT NULL,
  ann_date           TEXT NOT NULL,
  eps                REAL,
  dt_eps             REAL,
  profit_dedt        REAL,
  roe                REAL,
  roe_waa            REAL,
  roe_dt             REAL,
  grossprofit_margin REAL,
  netprofit_margin   REAL,
  basic_eps_yoy      REAL,
  dt_netprofit_yoy   REAL,
  netprofit_yoy      REAL,
  or_yoy             REAL,
  tr_yoy             REAL,
  q_eps              REAL,
  q_dtprofit         REAL,
  q_sales_yoy        REAL,
  q_netprofit_yoy    REAL,
  q_profit_yoy       REAL,
  q_gr_yoy           REAL,
  q_dt_roe           REAL,
  debt_to_assets     REAL,
  update_flag        TEXT,
  PRIMARY KEY (ts_code, end_date, ann_date)
);
CREATE INDEX IF NOT EXISTS idx_fina_ts_code ON fina_indicator (ts_code);

-- 前十大流通股东（I 因子）
CREATE TABLE IF NOT EXISTS top10_floatholders (
  ts_code          TEXT NOT NULL,
  end_date         TEXT NOT NULL,
  ann_date         TEXT,
  holder_name      TEXT NOT NULL,
  hold_amount      REAL,
  hold_ratio       REAL,
  hold_float_ratio REAL,
  hold_change      REAL,
  holder_type      TEXT,
  PRIMARY KEY (ts_code, end_date, holder_name)
);
CREATE INDEX IF NOT EXISTS idx_top10_ts_code ON top10_floatholders (ts_code);

-- 股东户数（S / I 因子）
CREATE TABLE IF NOT EXISTS stk_holdernumber (
  ts_code    TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  ann_date   TEXT,
  holder_num INTEGER,
  PRIMARY KEY (ts_code, end_date)
);
CREATE INDEX IF NOT EXISTS idx_holdernum_ann ON stk_holdernumber (ann_date);

-- 在线取数日志：记录「某接口的某个 key 已在何时拉取过」，避免重复消耗接口配额
CREATE TABLE IF NOT EXISTS fetch_log (
  api        TEXT NOT NULL,
  key        TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  PRIMARY KEY (api, key)
);
`;

/**
 * 打开（或创建）本地库，并确保 schema 就绪。
 *
 * @param path 库文件路径；传入 ":memory:" 可用于测试
 */
export function openDb(path: string = DEFAULT_DB_PATH): Database {
  try {
    // 内存库无需建目录
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path, { create: true });
    // WAL 提升并发读与批量写吞吐；NORMAL 放宽 fsync（本地缓存库可接受）
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    ensureSchema(db);
    return db;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CanSlimError(`打开本地库失败（${path}）：${message}`, undefined, "db");
  }
}

/** 执行建表语句；可重复调用（幂等） */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}

/** 读取键值元信息 */
export function getMeta(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM sync_meta WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

/** 写入键值元信息（UPSERT） */
export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/** 判断某个 (交易日, 表名) 同步单元是否已完成 */
export function isDaySynced(db: Database, tradeDate: string, tableName: string): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(1) AS n FROM sync_progress WHERE trade_date = ? AND table_name = ?"
    )
    .get(tradeDate, tableName);
  return (row?.n ?? 0) > 0;
}

/** 标记某个 (交易日, 表名) 同步单元已完成 */
export function markDaySynced(
  db: Database,
  tradeDate: string,
  tableName: string,
  rows: number
): void {
  db.query(
    `INSERT INTO sync_progress (trade_date, table_name, rows, done_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(trade_date, table_name) DO UPDATE SET
       rows = excluded.rows, done_at = excluded.done_at`
  ).run(tradeDate, tableName, rows, new Date().toISOString());
}

// ===== 在线取数日志（避免重复消耗接口配额） =====

/**
 * 判断某个 (接口, key) 是否已在有效期内拉取过。
 *
 * @param maxAgeDays 缓存有效期（天）。财务数据按季度更新，默认 7 天足够；
 *                   传 0 表示只要拉过就算命中（用于历史回测场景）
 */
export function isFetched(
  db: Database,
  api: string,
  key: string,
  maxAgeDays = 7
): boolean {
  const row = db
    .query<{ fetched_at: string }, [string, string]>(
      "SELECT fetched_at FROM fetch_log WHERE api = ? AND key = ?"
    )
    .get(api, key);
  if (!row) return false;
  if (maxAgeDays <= 0) return true;

  const age = Date.now() - new Date(row.fetched_at).getTime();
  return age < maxAgeDays * 24 * 60 * 60 * 1000;
}

/** 记录某个 (接口, key) 的拉取时间与行数 */
export function markFetched(db: Database, api: string, key: string, rows: number): void {
  db.query(
    `INSERT INTO fetch_log (api, key, fetched_at, rows) VALUES (?, ?, ?, ?)
     ON CONFLICT(api, key) DO UPDATE SET
       fetched_at = excluded.fetched_at, rows = excluded.rows`
  ).run(api, key, new Date().toISOString(), rows);
}

/** 批量筛出「尚未拉取或已过期」的 key */
export function filterUnfetched(
  db: Database,
  api: string,
  keys: string[],
  maxAgeDays = 7
): string[] {
  return keys.filter((k) => !isFetched(db, api, k, maxAgeDays));
}

/** 本地库数据覆盖概况（供 /api/can-slim/data-status 与同步脚本收尾打印使用） */
export interface DbCoverage {
  dailyRows: number;
  dailyMinDate: string | null;
  dailyMaxDate: string | null;
  dailyBasicRows: number;
  adjFactorRows: number;
  indexDailyRows: number;
  stockBasicRows: number;
  syncedDays: number;
  lastSyncAt: string | null;
}

/** 统计本地库覆盖情况 */
export function getCoverage(db: Database): DbCoverage {
  const one = <T>(sql: string): T | null => db.query<T, []>(sql).get() ?? null;

  const daily = one<{ n: number; min_d: string | null; max_d: string | null }>(
    "SELECT COUNT(1) AS n, MIN(trade_date) AS min_d, MAX(trade_date) AS max_d FROM daily"
  );
  const basic = one<{ n: number }>("SELECT COUNT(1) AS n FROM daily_basic");
  const adj = one<{ n: number }>("SELECT COUNT(1) AS n FROM adj_factor");
  const idx = one<{ n: number }>("SELECT COUNT(1) AS n FROM index_daily");
  const sb = one<{ n: number }>("SELECT COUNT(1) AS n FROM stock_basic");
  const days = one<{ n: number }>(
    "SELECT COUNT(DISTINCT trade_date) AS n FROM sync_progress WHERE table_name = 'daily'"
  );

  return {
    dailyRows: daily?.n ?? 0,
    dailyMinDate: daily?.min_d ?? null,
    dailyMaxDate: daily?.max_d ?? null,
    dailyBasicRows: basic?.n ?? 0,
    adjFactorRows: adj?.n ?? 0,
    indexDailyRows: idx?.n ?? 0,
    stockBasicRows: sb?.n ?? 0,
    syncedDays: days?.n ?? 0,
    lastSyncAt: getMeta(db, "last_sync_at"),
  };
}

// ===== 批量写入 =====

/**
 * 在单个事务内批量 UPSERT。
 *
 * 之所以统一走这里：SQLite 单条 INSERT 各自提交时吞吐极低，
 * 而一个交易日的全市场数据约 5500 行，必须合并到一个事务里写。
 *
 * @param db 数据库连接
 * @param table 目标表名（由调用方传入固定字面量，不接受外部输入）
 * @param columns 列名数组
 * @param rows 待写入行（对象数组，按 columns 取值）
 * @param conflictKeys 主键列，用于 ON CONFLICT
 * @returns 实际写入的行数
 */
export function upsertRows(
  db: Database,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  conflictKeys: string[]
): number {
  if (rows.length === 0) return 0;

  const placeholders = columns.map(() => "?").join(", ");
  // 冲突时更新非主键列；若全为主键列则退化为 DO NOTHING
  const updatableColumns = columns.filter((c) => !conflictKeys.includes(c));
  const updateClause =
    updatableColumns.length > 0
      ? `DO UPDATE SET ${updatableColumns.map((c) => `${c} = excluded.${c}`).join(", ")}`
      : "DO NOTHING";

  const sql =
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${conflictKeys.join(", ")}) ${updateClause}`;

  const stmt = db.query(sql);
  const writeAll = db.transaction((batch: Record<string, unknown>[]) => {
    for (const row of batch) {
      // Tushare 缺失值可能是 undefined，SQLite 绑定不接受 undefined，统一转为 null
      stmt.run(...columns.map((c) => (row[c] === undefined ? null : (row[c] as never))));
    }
  });

  try {
    writeAll(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CanSlimError(`写入本地库 ${table} 失败：${message}`, undefined, "db");
  }
  return rows.length;
}
