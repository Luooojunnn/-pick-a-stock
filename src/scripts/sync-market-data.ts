// 行情数据增量同步脚本（CLI）
//
// 用途：把 Tushare 的全市场行情按「交易日循环」落入本地 sqlite 库，
// 供 CAN SLIM 各因子本地计算（RS 全市场排名、52 周新高、20 日均量等）。
// Tushare 官方对 daily 的建议正是「循环日期提取全市场，不要循环 ts_code」。
//
// 用法：
//   bun run src/scripts/sync-market-data.ts                    # 增量同步到最近交易日
//   bun run src/scripts/sync-market-data.ts --start 20260801   # 指定起始日
//   bun run src/scripts/sync-market-data.ts --start 20230101 --end 20260910
//   bun run src/scripts/sync-market-data.ts --interval 250     # 放慢调用（积分较低时）
//   bun run src/scripts/sync-market-data.ts --force            # 忽略已同步记录，重新拉取
//   bun run src/scripts/sync-market-data.ts --no-basic         # 跳过 daily_basic
//   bun run src/scripts/sync-market-data.ts --db /tmp/test.sqlite
//
// 断点续跑：每个 (交易日, 表名) 同步成功后写入 sync_progress，
// 中断后重新执行会自动跳过已完成单元。

import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import {
  openDb,
  upsertRows,
  isDaySynced,
  markDaySynced,
  setMeta,
  getCoverage,
  DEFAULT_DB_PATH,
} from "../apis/can-slim/db";
import {
  fetchTradeCal,
  fetchStockBasic,
  fetchDailyByDate,
  fetchAdjFactorByDate,
  fetchDailyBasicByDate,
  fetchIndexDaily,
  setMinCallInterval,
} from "../apis/can-slim/data-source";
import { CanSlimError } from "../apis/can-slim/types";

/** M 因子所需的四大指数 */
const MARKET_INDEXES = ["000001.SH", "399001.SZ", "000300.SH", "399006.SZ"];

/** 本地库为空时的默认回溯年数（3 年可覆盖 250 交易日 RS 与 3 年 EPS CAGR 所需行情） */
const DEFAULT_LOOKBACK_YEARS = 3;

// ===== 日期工具 =====

/** 取今天的 YYYYMMDD（本地时区） */
function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 在 YYYYMMDD 上前推若干年 */
function subtractYears(ymd: string, years: number): string {
  const y = Number(ymd.slice(0, 4)) - years;
  return `${y}${ymd.slice(4)}`;
}

/** 在 YYYYMMDD 上加减自然日 */
function addDays(ymd: string, delta: number): string {
  const dt = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  );
  dt.setUTCDate(dt.getUTCDate() + delta);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** 秒数格式化为 mm:ss */
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// ===== 各表同步 =====

/** 同步股票基础信息（全量覆盖） */
async function syncStockBasic(db: Database): Promise<number> {
  const rows = await fetchStockBasic();
  return upsertRows(
    db,
    "stock_basic",
    ["ts_code", "name", "industry", "market", "list_date"],
    rows as unknown as Record<string, unknown>[],
    ["ts_code"]
  );
}

/** 同步交易日历，返回区间内的开市日（升序） */
async function syncTradeCal(
  db: Database,
  startDate: string,
  endDate: string
): Promise<string[]> {
  const rows = await fetchTradeCal(startDate, endDate);
  upsertRows(
    db,
    "trade_cal",
    ["exchange", "cal_date", "is_open", "pretrade_date"],
    rows as unknown as Record<string, unknown>[],
    ["exchange", "cal_date"]
  );
  return rows.map((r) => r.cal_date);
}

/** 同步四大指数日线 */
async function syncIndexes(
  db: Database,
  startDate: string,
  endDate: string
): Promise<number> {
  let total = 0;
  for (const code of MARKET_INDEXES) {
    const rows = await fetchIndexDaily(code, startDate, endDate);
    total += upsertRows(
      db,
      "index_daily",
      ["ts_code", "trade_date", "open", "high", "low", "close", "pct_chg", "vol", "amount"],
      rows as unknown as Record<string, unknown>[],
      ["ts_code", "trade_date"]
    );
  }
  return total;
}

/** 同步单个交易日的三张行情表 */
async function syncOneDay(
  db: Database,
  tradeDate: string,
  opts: { force: boolean; withBasic: boolean }
): Promise<{ daily: number; adj: number; basic: number; skipped: boolean; noData: boolean }> {
  const needDaily = opts.force || !isDaySynced(db, tradeDate, "daily");
  const needAdj = opts.force || !isDaySynced(db, tradeDate, "adj_factor");
  const needBasic =
    opts.withBasic && (opts.force || !isDaySynced(db, tradeDate, "daily_basic"));

  if (!needDaily && !needAdj && !needBasic) {
    return { daily: 0, adj: 0, basic: 0, skipped: true, noData: false };
  }

  let dailyCount = 0;
  let adjCount = 0;
  let basicCount = 0;

  if (needDaily) {
    const rows = await fetchDailyByDate(tradeDate);
    // 空结果通常意味着当日数据尚未入库（daily 每日 15~16 点入库），
    // 此时不标记完成，留待下次同步补齐。
    if (rows.length === 0) {
      return { daily: 0, adj: 0, basic: 0, skipped: false, noData: true };
    }
    dailyCount = upsertRows(
      db,
      "daily",
      [
        "ts_code",
        "trade_date",
        "open",
        "high",
        "low",
        "close",
        "pre_close",
        "pct_chg",
        "vol",
        "amount",
      ],
      rows as unknown as Record<string, unknown>[],
      ["ts_code", "trade_date"]
    );
    markDaySynced(db, tradeDate, "daily", dailyCount);
  }

  if (needAdj) {
    const rows = await fetchAdjFactorByDate(tradeDate);
    if (rows.length > 0) {
      adjCount = upsertRows(
        db,
        "adj_factor",
        ["ts_code", "trade_date", "adj_factor"],
        rows as unknown as Record<string, unknown>[],
        ["ts_code", "trade_date"]
      );
      markDaySynced(db, tradeDate, "adj_factor", adjCount);
    }
  }

  if (needBasic) {
    const rows = await fetchDailyBasicByDate(tradeDate);
    if (rows.length > 0) {
      basicCount = upsertRows(
        db,
        "daily_basic",
        [
          "ts_code",
          "trade_date",
          "close",
          "turnover_rate",
          "turnover_rate_f",
          "volume_ratio",
          "float_share",
          "free_share",
          "circ_mv",
          "total_mv",
          "limit_status",
        ],
        rows as unknown as Record<string, unknown>[],
        ["ts_code", "trade_date"]
      );
      markDaySynced(db, tradeDate, "daily_basic", basicCount);
    }
  }

  return { daily: dailyCount, adj: adjCount, basic: basicCount, skipped: false, noData: false };
}

// ===== 主流程 =====

export interface SyncOptions {
  start?: string;
  end?: string;
  intervalMs?: number;
  dbPath?: string;
  force?: boolean;
  withBasic?: boolean;
}

/**
 * 执行一次增量同步。
 *
 * 起始日推导：显式 --start 优先；否则从本地库已有的最大交易日次日开始（增量）；
 * 本地库为空时回溯 DEFAULT_LOOKBACK_YEARS 年。
 */
export async function runSync(options: SyncOptions = {}): Promise<void> {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const withBasic = options.withBasic ?? true;
  const force = options.force ?? false;
  setMinCallInterval(options.intervalMs ?? 150);

  const db = openDb(dbPath);
  const t0 = Date.now();

  try {
    const coverage = getCoverage(db);
    const endDate = options.end ?? todayYmd();
    const startDate =
      options.start ??
      (coverage.dailyMaxDate
        ? addDays(coverage.dailyMaxDate, 1)
        : subtractYears(endDate, DEFAULT_LOOKBACK_YEARS));

    console.log(`📁 本地库：${dbPath}`);
    console.log(
      `📊 当前覆盖：daily ${coverage.dailyRows} 行` +
        (coverage.dailyMinDate ? `（${coverage.dailyMinDate} ~ ${coverage.dailyMaxDate}）` : "（空库）")
    );
    console.log(`🎯 本次同步区间：${startDate} ~ ${endDate}${force ? "（--force 强制重拉）" : ""}`);

    if (startDate > endDate) {
      console.log("✅ 本地库已是最新，无需同步。");
      return;
    }

    // 1. 股票基础信息（每次全量覆盖，行业与上市日期会变动）
    const sbCount = await syncStockBasic(db);
    console.log(`✅ stock_basic：${sbCount} 只`);

    // 2. 交易日历，得到区间内所有开市日
    const tradeDates = await syncTradeCal(db, startDate, endDate);
    console.log(`✅ trade_cal：区间内 ${tradeDates.length} 个交易日`);

    if (tradeDates.length === 0) {
      console.log("⚠️  区间内没有交易日，结束。");
      return;
    }

    // 3. 指数日线（M 因子）；MA200 需要更长历史，故起始日额外前推一年
    const indexStart = subtractYears(startDate, 1);
    const idxCount = await syncIndexes(db, indexStart, endDate);
    console.log(`✅ index_daily：${MARKET_INDEXES.join(", ")} 共 ${idxCount} 行`);

    // 4. 逐交易日同步行情
    let done = 0;
    let skipped = 0;
    let noData = 0;
    let totalRows = 0;

    for (const tradeDate of tradeDates) {
      const r = await syncOneDay(db, tradeDate, { force, withBasic });
      if (r.skipped) {
        skipped++;
      } else if (r.noData) {
        noData++;
        console.log(`⏭️  ${tradeDate}：暂无数据（当日行情可能尚未入库），跳过`);
      } else {
        done++;
        totalRows += r.daily + r.adj + r.basic;
      }

      const processed = done + skipped + noData;
      // 每 20 个交易日打印一次进度与预估剩余时间
      if (processed % 20 === 0 || processed === tradeDates.length) {
        const elapsed = Date.now() - t0;
        const avg = elapsed / processed;
        const remain = avg * (tradeDates.length - processed);
        console.log(
          `   进度 ${processed}/${tradeDates.length}（新增 ${done} / 跳过 ${skipped} / 无数据 ${noData}）` +
            ` 已用 ${fmtDuration(elapsed)}，预计剩余 ${fmtDuration(remain)}`
        );
      }
    }

    setMeta(db, "last_sync_at", new Date().toISOString());
    setMeta(db, "last_sync_end_date", endDate);

    const after = getCoverage(db);
    console.log("\n=========== 同步完成 ===========");
    console.log(`耗时：${fmtDuration(Date.now() - t0)}`);
    console.log(`新增同步 ${done} 个交易日，跳过 ${skipped} 个，无数据 ${noData} 个，写入约 ${totalRows} 行`);
    console.log(
      `本地库：daily ${after.dailyRows} 行（${after.dailyMinDate} ~ ${after.dailyMaxDate}）、` +
        `adj_factor ${after.adjFactorRows} 行、daily_basic ${after.dailyBasicRows} 行、` +
        `index_daily ${after.indexDailyRows} 行、stock_basic ${after.stockBasicRows} 只`
    );
    console.log(`已完成同步的交易日数：${after.syncedDays}`);
  } finally {
    db.close();
  }
}

// ===== CLI 入口 =====

/** 仅在作为脚本直接执行时运行（被测试 import 时不触发） */
if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      start: { type: "string" },
      end: { type: "string" },
      interval: { type: "string" },
      db: { type: "string" },
      force: { type: "boolean", default: false },
      "no-basic": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
行情数据增量同步

  --start <YYYYMMDD>   起始交易日（默认：本地库最大日期次日；空库则回溯 ${DEFAULT_LOOKBACK_YEARS} 年）
  --end   <YYYYMMDD>   结束交易日（默认：今天）
  --interval <ms>      相邻接口调用的最小间隔，默认 150
  --db <path>          本地库路径，默认 ${DEFAULT_DB_PATH}
  --force              忽略 sync_progress，重新拉取区间内所有交易日
  --no-basic           跳过 daily_basic（可减少约 1/3 调用量）
  --help               显示本帮助
`);
    process.exit(0);
  }

  try {
    await runSync({
      start: values.start,
      end: values.end,
      intervalMs: values.interval ? Number(values.interval) : undefined,
      dbPath: values.db,
      force: values.force,
      withBasic: !values["no-basic"],
    });
  } catch (err) {
    if (err instanceof CanSlimError) {
      console.error(`\n❌ 同步失败【${err.kind ?? "generic"}】${err.apiName ? `接口 ${err.apiName}` : ""}`);
      console.error(err.message);
    } else {
      console.error("\n❌ 同步失败：", err);
    }
    process.exit(1);
  }
}
