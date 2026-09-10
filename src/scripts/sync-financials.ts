// 财务与机构数据预热脚本（CLI）
//
// 为什么需要单独一个脚本：
// fina_indicator / top10_floatholders 只能按单只股票取数，且实测限额为 200 次/分钟。
// 400 只候选需要约 2.5 分钟，1500 只需要约 9 分钟——放在 HTTP 请求里同步执行不现实。
// 因此把这部分做成离线预热：脚本慢慢拉、落本地库，选股接口只读缓存，秒级返回。
//
// 用法：
//   bun run src/scripts/sync-financials.ts                  # 预热技术面前 400 名
//   bun run src/scripts/sync-financials.ts --top 800         # 扩大预热范围
//   bun run src/scripts/sync-financials.ts --all             # 预热全部通过 RS 门槛的股票
//   bun run src/scripts/sync-financials.ts --date 20260630   # 按历史基准日预热
//   bun run src/scripts/sync-financials.ts --skip-holders    # 只拉财务，跳过机构持仓
//   bun run src/scripts/sync-financials.ts --interval 400    # 放慢速率
//
// 断点续跑：每只股票拉取成功后写入 fetch_log，中断后重新执行会自动跳过已完成的部分。

import { parseArgs } from "node:util";
import { openDb, DEFAULT_DB_PATH } from "../apis/can-slim/db";
import { getStockBasics, resolveAsOfTradeDate, getBarsForCodes, getDailyBasicMap } from "../apis/can-slim/repository";
import { computeLeaderFactors, buildUniverse, passRsGate } from "../apis/can-slim/factors/l-leader";
import { computeNewFactor } from "../apis/can-slim/factors/n-new";
import { computeSupplyFactor } from "../apis/can-slim/factors/s-supply";
import { resolveConfig } from "../apis/can-slim/config";
import {
  ensureFinaIndicators,
  ensureTop10FloatHolders,
  ensureHolderNumbers,
  getVisibleFinaIndicatorsForCodes,
} from "../apis/can-slim/financials";
import { computeCurrentEarningsFactor, passCurrentEarningsGate } from "../apis/can-slim/factors/c-current";
import { computeAnnualEarningsFactor, passAnnualEarningsGate } from "../apis/can-slim/factors/a-annual";
import { setApiMinInterval } from "../apis/can-slim/data-source";
import { CanSlimError } from "../apis/can-slim/types";

/** K 线窗口，与 service 保持一致 */
const BAR_WINDOW = 270;

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export interface SyncFinancialsOptions {
  date?: string;
  /** 预热多少只（按技术面评分排序）；传 Infinity 表示全部 */
  top?: number;
  dbPath?: string;
  intervalMs?: number;
  skipHolders?: boolean;
}

export async function runSyncFinancials(options: SyncFinancialsOptions = {}): Promise<void> {
  const cfg = resolveConfig();
  const db = openDb(options.dbPath ?? DEFAULT_DB_PATH);
  const t0 = Date.now();

  try {
    if (options.intervalMs) {
      for (const api of ["fina_indicator", "top10_floatholders", "stk_holdernumber"]) {
        setApiMinInterval(api, options.intervalMs);
      }
      console.log(`⏱️  逐只接口调用间隔设为 ${options.intervalMs}ms`);
    }

    // ===== 基准日 =====
    const requested = options.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const asOfDate = resolveAsOfTradeDate(db, requested);
    if (!asOfDate) {
      console.error(
        `❌ 本地库中没有不晚于 ${requested} 的行情数据，请先执行：bun run src/scripts/sync-market-data.ts`
      );
      process.exit(1);
    }
    console.log(`📁 本地库：${options.dbPath ?? DEFAULT_DB_PATH}`);
    console.log(`🎯 基准日：${asOfDate}`);

    // ===== 用本地因子确定预热范围 =====
    console.log("\n计算技术面因子以确定预热范围（本地计算，无接口调用）…");
    const stocks = getStockBasics(db);
    const { universe } = buildUniverse(stocks, cfg);
    const leader = computeLeaderFactors(db, asOfDate, cfg, universe);
    const rsPassed = [...leader.byCode.entries()]
      .filter(([, r]) => passRsGate(r, cfg))
      .map(([code]) => code);
    console.log(`✅ 股票池 ${universe.length} 只，RS ≥ ${cfg.l.rsMin} 通过 ${rsPassed.length} 只`);

    if (rsPassed.length === 0) {
      console.log("⚠️  没有股票通过 RS 门槛，无需预热。");
      return;
    }

    // 按技术面综合分排序，优先预热最可能入选的标的
    const barsMap = getBarsForCodes(db, rsPassed, asOfDate, BAR_WINDOW);
    const dailyBasicMap = getDailyBasicMap(db, asOfDate);
    const pw = cfg.screen.preScreenWeights;
    const ranked = rsPassed
      .map((code) => {
        const bars = barsMap.get(code) ?? [];
        const l = leader.byCode.get(code)?.score ?? 0;
        const n = computeNewFactor(bars, cfg).score ?? 0;
        const s = computeSupplyFactor(bars, dailyBasicMap.get(code), null, cfg).score ?? 0;
        return { code, techScore: l * pw.l + n * pw.n + s * pw.s };
      })
      .sort((a, b) => b.techScore - a.techScore);

    const limit = options.top ?? cfg.screen.maxFinancialFetch;
    const targets = ranked.slice(0, limit).map((x) => x.code);
    console.log(`📊 预热范围：技术面前 ${targets.length} 只（共 ${ranked.length} 只通过 RS 门槛）`);

    // ===== 财务指标 =====
    const estMinutes = ((targets.length * 0.35) / 60).toFixed(1);
    console.log(`\n[1/3] 拉取财务指标 fina_indicator（预计 ${estMinutes} 分钟，限额 200 次/分钟）…`);
    const finaResult = await ensureFinaIndicators(db, targets, asOfDate, (done, total) => {
      const elapsed = Date.now() - t0;
      const remain = (elapsed / done) * (total - done);
      console.log(`   进度 ${done}/${total}，已用 ${fmtDuration(elapsed)}，预计剩余 ${fmtDuration(remain)}`);
    });
    console.log(
      `✅ 财务指标：在线 ${finaResult.fetched} 只 / 缓存 ${finaResult.cached} 只 / 失败 ${finaResult.failed} 只`
    );
    if (finaResult.permissionDenied) {
      console.error(`❌ fina_indicator 权限不足：${finaResult.firstError}`);
      console.error("   C / A 因子将整体降级，选股结果会退化为技术面筛选。");
    }

    // ===== 股东户数（批量，成本低） =====
    console.log("\n[2/3] 拉取股东户数 stk_holdernumber（按月分段批量）…");
    const holderNumResult = await ensureHolderNumbers(db, asOfDate);
    console.log(
      `✅ 股东户数：在线 ${holderNumResult.fetched} 个窗口 / 缓存 ${holderNumResult.cached} 个 / 失败 ${holderNumResult.failed} 个`
    );

    // ===== 机构持仓（逐只，成本高） =====
    //
    // 关键：预热范围必须是「通过财务门槛的候选」，而不是「技术面前 N 名」。
    // 这两个集合差异很大——财务门槛会把 400 只砍到几十只，而这几十只里
    // 有相当一部分技术面排名并不靠前。按技术面截断会让最终候选的 I 因子
    // 无谓降级；按财务门槛筛完再拉，既精准又把调用量降到最低。
    if (options.skipHolders) {
      console.log("\n[3/3] 已指定 --skip-holders，跳过机构持仓");
    } else {
      const finaByCode = getVisibleFinaIndicatorsForCodes(db, targets, asOfDate);
      const financialPassed = targets.filter((code) => {
        const periods = finaByCode.get(code) ?? [];
        if (periods.length === 0) return false;
        const c = computeCurrentEarningsFactor(periods, cfg);
        const a = computeAnnualEarningsFactor(periods, cfg);
        return passCurrentEarningsGate(c, cfg) && passAnnualEarningsGate(a, cfg);
      });

      const holderTargets = financialPassed.slice(0, cfg.screen.maxInstitutionFetch);
      console.log(
        `\n[3/3] 财务门槛通过 ${financialPassed.length} 只，为其拉取机构持仓 top10_floatholders` +
          `（${holderTargets.length} 只，预计 ${((holderTargets.length * 0.35) / 60).toFixed(1)} 分钟）…`
      );

      if (holderTargets.length === 0) {
        console.log("⚠️  没有股票通过财务门槛，跳过机构持仓");
      } else {
        const holdersResult = await ensureTop10FloatHolders(
          db,
          holderTargets,
          asOfDate,
          (done, total) => console.log(`   进度 ${done}/${total}`)
        );
        console.log(
          `✅ 机构持仓：在线 ${holdersResult.fetched} 只 / 缓存 ${holdersResult.cached} 只 / 失败 ${holdersResult.failed} 只`
        );
        if (holdersResult.permissionDenied) {
          console.error(`❌ top10_floatholders 权限不足：${holdersResult.firstError}`);
        }
      }
    }

    // ===== 收尾统计 =====
    const finaCount =
      db.query<{ n: number }, []>("SELECT COUNT(DISTINCT ts_code) AS n FROM fina_indicator").get()
        ?.n ?? 0;
    const holdersCount =
      db
        .query<{ n: number }, []>("SELECT COUNT(DISTINCT ts_code) AS n FROM top10_floatholders")
        .get()?.n ?? 0;
    const holderNumCount =
      db.query<{ n: number }, []>("SELECT COUNT(DISTINCT ts_code) AS n FROM stk_holdernumber").get()
        ?.n ?? 0;

    console.log("\n=========== 预热完成 ===========");
    console.log(`耗时：${fmtDuration(Date.now() - t0)}`);
    console.log(
      `本地缓存：财务指标 ${finaCount} 只、机构持仓 ${holdersCount} 只、股东户数 ${holderNumCount} 只`
    );
    console.log("现在可以直接访问 /api/can-slim，接口只读本地缓存，秒级返回。");
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      date: { type: "string" },
      top: { type: "string" },
      all: { type: "boolean", default: false },
      db: { type: "string" },
      interval: { type: "string" },
      "skip-holders": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
财务与机构数据预热

  --date <YYYYMMDD>   基准日（默认今天，会回退到最近交易日）
  --top <n>           预热技术面前 n 只（默认 400）
  --all               预热全部通过 RS 门槛的股票
  --interval <ms>     逐只接口的调用间隔，默认 350（对应 200 次/分钟限额）
  --skip-holders      跳过机构持仓（top10_floatholders）
  --db <path>         本地库路径，默认 ${DEFAULT_DB_PATH}
  --help              显示本帮助

说明：fina_indicator 与 top10_floatholders 的限额均为 200 次/分钟，
      预热 400 只约需 2.5 分钟。中断可直接重跑，已完成部分会自动跳过。
`);
    process.exit(0);
  }

  try {
    await runSyncFinancials({
      date: values.date,
      top: values.all ? Number.POSITIVE_INFINITY : values.top ? Number(values.top) : undefined,
      dbPath: values.db,
      intervalMs: values.interval ? Number(values.interval) : undefined,
      skipHolders: values["skip-holders"],
    });
  } catch (err) {
    if (err instanceof CanSlimError) {
      console.error(`\n❌ 预热失败【${err.kind ?? "generic"}】${err.apiName ? `接口 ${err.apiName}` : ""}`);
      console.error(err.message);
    } else {
      console.error("\n❌ 预热失败：", err);
    }
    process.exit(1);
  }
}
