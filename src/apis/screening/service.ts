// 筛选服务编排（service.ts）
// 对应 design.md「筛选服务编排（service.ts）」「pipeline 编排（pipeline.ts / service.ts）」章节，
// 以及需求 1.1、1.6、1.7、9.1、9.2、9.3、9.4。
//
// 职责：把带副作用的数据获取层（data-source）、基准日探测（reference-day）与纯函数
// 筛选管线（pipeline）编排起来，完成一次完整筛选并组装出候选股票列表。
//
// 编排流程：
//   1. fetchStockBasic()：取全量上市股票；空/失败由该函数内部抛 ScreeningError（需求 1.1、1.6）。
//   2. resolveReferenceDay()：确定基准日；无可用基准日抛 ScreeningError（需求 1.7）。
//   3. 拉取基准日 daily / daily_basic 全市场截面，并按 ts_code 建索引。
//   4. 阶段 A（runStageA）：主板→涨幅→量比→换手率→流通市值，低成本短路缩小候选集。
//   5. 阶段 B（runStageB）：对幸存候选按方案 A 拉取历史序列，做成交量递增与均线趋势分级。
//   6. 阶段 C（applyIntradayFilter）：分时对比占位，当前禁用直接透传，不排除任何股票（需求 8.6）。
//
// 空结果不视为错误：只要未发生接口级错误，返回空数组即可（需求 9.3、9.4）。

import type {
  StockBasicRow,
  DailyRow,
  DailyBasicRow,
  WorkingCandidate,
  CandidateStock,
  ExclusionRecord,
  ScreeningContext,
} from "./types";
import {
  fetchStockBasic,
  fetchDailyByDate,
  fetchDailyBasicByDate,
  fetchDailyHistory,
} from "./data-source";
import { resolveReferenceDay } from "./reference-day";
import { runStageA, runStageB } from "./pipeline";
import { applyIntradayFilter, INTRADAY_ENABLED } from "./filters/intraday";

/** 阶段 B 历史序列的回溯自然日跨度：基准日前推约 90 个自然日，保证覆盖 61+ 交易日（需求 7.1） */
const HISTORY_LOOKBACK_DAYS = 90;

/**
 * 将带 ts_code 字段的行数组按 ts_code 建索引，便于 O(1) 查找。
 * 同一 ts_code 若出现多行（理论上不应发生），以最后一行为准。
 */
function index<T extends { ts_code: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.ts_code, row);
  }
  return map;
}

/**
 * 在 YYYYMMDD 基础上前推若干自然日，返回 YYYYMMDD。
 * 使用 UTC 运算避免时区/夏令时干扰（中国无夏令时）。
 *
 * @param yyyymmdd 基准日期 YYYYMMDD
 * @param deltaDays 前推天数（正数表示往前回溯）
 */
function subtractDays(yyyymmdd: string, deltaDays: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * 将工作态候选（含定型分级）组装为对外的候选股票结构（需求 9.2）。
 *
 * 仅在候选的 volumeGrade 与 maGrade 均已确定时调用；组装结果必然包含
 * ts_code、name、volumeGrade、maGrade 四个字段（Property 13）。
 */
export function assembleCandidate(cand: WorkingCandidate): CandidateStock {
  return {
    ts_code: cand.ts_code,
    name: cand.name,
    // 到达此处的候选一定已通过阶段 B 判定并定型分级，故断言非空
    volumeGrade: cand.volumeGrade!,
    maGrade: cand.maGrade!,
  };
}

/** 生成带耗时的诊断日志行；同时打印到服务端控制台 */
function makeLogger(logs: string[]) {
  const t0 = Date.now();
  return (message: string) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const line = `[+${elapsed}s] ${message}`;
    logs.push(line);
    console.log(`[screening] ${line}`);
  };
}

/**
 * 执行一次完整的多条件选股筛选，返回候选股票列表（需求 1.1、9.1–9.4）。
 *
 * @param logs 诊断日志接收数组（按引用传入）。每个阶段的进度会写入其中；
 *             即使中途抛错，调用方仍可读取该数组以定位失败环节。
 * @returns 通过全部已启用筛选条件的候选股票数组（可能为空，空不视为错误）
 * @throws ScreeningError 当发生接口级失败（股票列表获取失败、无可用基准日、接口错误/超时/权限不足等）
 */
export async function runScreening(
  logs: string[] = []
): Promise<CandidateStock[]> {
  const log = makeLogger(logs);
  // 诊断/排除记录：本地维护，供后续排查（需求 4.4/5.4/6.5）
  const records: ExclusionRecord[] = [];

  log("当前在 runScreening：开始执行筛选流程");

  log("当前在 fetchStockBasic：开始获取股票列表 (stock_basic)…");
  // 1. 取全量上市股票；失败/频控时 data-source 层回退本地兜底列表（需求 1.1）
  const stocks: StockBasicRow[] = await fetchStockBasic();
  log(`当前在 fetchStockBasic：股票列表获取成功，共 ${stocks.length} 只`);

  log("当前在 resolveReferenceDay：开始探测基准日 (trade_cal + daily/daily_basic 探针)…");
  // 2. 确定基准日；无可用基准日抛 ScreeningError（需求 1.5、1.7）
  const referenceDay = await resolveReferenceDay();
  log(`当前在 resolveReferenceDay：基准日确定为 ${referenceDay}`);

  const ctx: ScreeningContext = {
    referenceDay,
    intradayEnabled: INTRADAY_ENABLED,
  };

  log(`当前在 fetchDailyByDate：开始拉取基准日 daily 截面 (trade_date=${referenceDay})…`);
  // 3. 拉取基准日全市场截面 daily / daily_basic，并按 ts_code 建索引
  const dailyRows: DailyRow[] = await fetchDailyByDate(referenceDay);
  log(`当前在 fetchDailyByDate：daily 截面获取成功，${dailyRows.length} 行`);

  log(`当前在 fetchDailyBasicByDate：开始拉取基准日 daily_basic 截面 (trade_date=${referenceDay})…`);
  const basicRows: DailyBasicRow[] = await fetchDailyBasicByDate(referenceDay);
  log(`当前在 fetchDailyBasicByDate：daily_basic 截面获取成功，${basicRows.length} 行`);

  const dailyByCode = index(dailyRows);
  const basicByCode = index(basicRows);

  log("当前在 runStageA：开始阶段A 截面筛选（主板→涨幅→量比→换手率→流通市值）…");
  // 4. 阶段 A：全市场截面低成本筛选，短路缩小候选集（需求 1.2–1.4、2–5）
  const survivors: WorkingCandidate[] = runStageA(
    stocks,
    dailyByCode,
    basicByCode,
    records
  );
  log(`当前在 runStageA：阶段A 通过 ${survivors.length} 只候选`);

  // 5. 阶段 B：仅对幸存候选按方案 A 拉取历史序列，做成交量递增与均线趋势分级（需求 6、7）
  const startDate = subtractDays(referenceDay, HISTORY_LOOKBACK_DAYS);
  const tsCodes = survivors.map((c) => c.ts_code);
  log(
    `当前在 fetchDailyHistory：开始拉取历史序列（${tsCodes.length} 只候选，区间 ${startDate}~${referenceDay}）…`
  );
  const historyByCode = await fetchDailyHistory(tsCodes, startDate, referenceDay);
  log(`当前在 fetchDailyHistory：历史序列拉取完成，${historyByCode.size} 只有数据`);

  // 打印进入阶段B 的候选（仅股票代码 + 名称），方便用户手工核对
  log("当前在 fetchDailyHistory：待筛选候选如下（便于手工核对）——");
  for (const cand of survivors) {
    log(`  · ${cand.ts_code} ${cand.name}`);
  }

  log("当前在 runStageB：开始阶段B 历史序列筛选（成交量递增 + 均线趋势分级）…");
  const stageBResult: CandidateStock[] = runStageB(
    survivors,
    historyByCode,
    records
  );
  log(`当前在 runStageB：阶段B 通过 ${stageBResult.length} 只候选`);

  log("当前在 applyIntradayFilter：开始阶段C 分时对比占位（当前禁用，直接透传）…");
  // 6. 阶段 C：分时对比占位，当前禁用直接透传、不排除任何股票（需求 8.6）
  const result = await applyIntradayFilter(stageBResult, ctx);
  log(`当前在 applyIntradayFilter：阶段C 完成，最终候选 ${result.length} 只`);

  log(`当前在 runScreening：筛选完成，返回 ${result.length} 只候选；累计排除记录 ${records.length} 条`);

  // 空结果不视为错误，直接返回（需求 9.3、9.4）
  return result;
}
