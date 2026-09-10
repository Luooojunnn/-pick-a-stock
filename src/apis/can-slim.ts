// CAN SLIM 选股接口
//
// GET /api/can-slim?date=YYYYMMDD&fetch=1   执行一次选股
//     date  省略则用本地库最近可用交易日；非交易日会自动回退
//     fetch 传 1 才允许在线补拉财务/机构数据（默认只读本地缓存）
// GET /api/can-slim/data-status              查看本地行情库覆盖情况
//
// 默认不在线取数的原因：fina_indicator 与 top10_floatholders 只能按单只股票取数，
// 实测限额 200 次/分钟，400 只候选需要约 2.5 分钟，放在 HTTP 请求里会超时。
// 这部分改由 bun run src/scripts/sync-financials.ts 离线预热，接口只读缓存、秒级返回。
//
// 响应格式沿用项目既有约定 { code, data, logs }：成功 code 为 0，失败 code 为 -1 且 HTTP 500。
// 本地库缺数据时不报错，而是返回 needSync 标记与同步命令，让前端能引导用户操作。

import { openDb, getCoverage, DEFAULT_DB_PATH } from "./can-slim/db";
import { runCanSlimScreening } from "./can-slim/service";
import { explainCandidate } from "./can-slim/scoring";
import { CanSlimError } from "./can-slim/types";

/** 校验 date 参数格式：8 位数字 */
function isValidYmd(s: string): boolean {
  return /^\d{8}$/.test(s);
}

export const route = {
  "/api/can-slim": {
    async GET(req: Request) {
      const logs: string[] = [];
      let db: ReturnType<typeof openDb> | null = null;

      try {
        const url = new URL(req.url);
        const dateParam = url.searchParams.get("date");
        if (dateParam && !isValidYmd(dateParam)) {
          return Response.json(
            { code: -1, message: `date 参数格式错误（需 YYYYMMDD）：${dateParam}`, logs },
            { status: 400 }
          );
        }
        // 默认只读本地缓存；显式传 fetch=1 才允许在线补拉（可能耗时数分钟）
        const allowFetch = url.searchParams.get("fetch") === "1";

        db = openDb();

        // 本地库为空：返回引导信息而非报错
        const coverage = getCoverage(db);
        if (coverage.dailyRows === 0) {
          return Response.json({
            code: 0,
            data: {
              needSync: true,
              coverage,
              message: "本地行情库为空，请先执行：bun run src/scripts/sync-market-data.ts",
            },
            logs,
          });
        }

        const result = await runCanSlimScreening(db, {
          date: dateParam ?? undefined,
          logs,
          allowFetch,
        });

        return Response.json({
          code: 0,
          data: {
            needSync: false,
            coverage,
            ...result,
          },
          logs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logs.push(`❌ 出错：${message}`);
        console.error("[can-slim] 选股失败：", err);
        const detail =
          err instanceof CanSlimError ? { kind: err.kind, apiName: err.apiName } : undefined;
        return Response.json({ code: -1, message, detail, logs }, { status: 500 });
      } finally {
        db?.close();
      }
    },
  },

  "/api/can-slim/explain/:code": {
    /** 返回单只候选股的纯文本解释，便于复制分享或人工核对 */
    async GET(req: Request & { params: { code: string } }) {
      let db: ReturnType<typeof openDb> | null = null;
      try {
        const url = new URL(req.url);
        const dateParam = url.searchParams.get("date");
        const tsCode = req.params.code;

        db = openDb();
        const result = await runCanSlimScreening(db, {
          date: dateParam ?? undefined,
          allowFetch: url.searchParams.get("fetch") === "1",
        });

        const candidate = result.candidates.find((c) => c.ts_code === tsCode);
        if (!candidate) {
          return Response.json(
            { code: -1, message: `${tsCode} 不在本次候选列表中` },
            { status: 404 }
          );
        }

        return new Response(explainCandidate(candidate), {
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[can-slim] 生成解释失败：", err);
        return Response.json({ code: -1, message }, { status: 500 });
      } finally {
        db?.close();
      }
    },
  },

  "/api/can-slim/data-status": {
    async GET(_req: Request) {
      let db: ReturnType<typeof openDb> | null = null;
      try {
        db = openDb();
        const coverage = getCoverage(db);

        // 财务与机构数据的缓存覆盖情况
        const finaCount = db
          .query<{ n: number }, []>("SELECT COUNT(DISTINCT ts_code) AS n FROM fina_indicator")
          .get()?.n ?? 0;
        const holdersCount = db
          .query<{ n: number }, []>(
            "SELECT COUNT(DISTINCT ts_code) AS n FROM top10_floatholders"
          )
          .get()?.n ?? 0;
        const holderNumCount = db
          .query<{ n: number }, []>("SELECT COUNT(DISTINCT ts_code) AS n FROM stk_holdernumber")
          .get()?.n ?? 0;

        return Response.json({
          code: 0,
          data: {
            dbPath: DEFAULT_DB_PATH,
            ...coverage,
            latestAvailable: coverage.dailyMaxDate,
            needSync: coverage.dailyRows === 0,
            cachedFinancials: finaCount,
            cachedTop10Holders: holdersCount,
            cachedHolderNumbers: holderNumCount,
            syncCommand: "bun run src/scripts/sync-market-data.ts",
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[can-slim] 查询数据状态失败：", err);
        return Response.json({ code: -1, message }, { status: 500 });
      } finally {
        db?.close();
      }
    },
  },
};
