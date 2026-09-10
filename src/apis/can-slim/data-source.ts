// 在线取数层（data-source.ts）
//
// 封装 CAN SLIM 模块用到的全部 Tushare 调用，统一处理：
// - 单次调用超时（AbortController + 计时器）
// - 瞬时错误（网络抖动、超时、HTTP 5xx）有限重试
// - 频率限制（rate limit）识别与退避重试
// - 权限/积分不足识别：不重试，抛出 kind='permission'，由上层决定「因子降级」还是中止
// - 全局节流：保证相邻调用间隔不低于设定值，避免撞频控
//
// 与 screening / sell-advisor 两个模块的同类文件保持相同策略骨架（有意保留各自一份，
// 避免改动已跑通的模块）；差异在于本层额外处理频控退避与数值规范化。
//
// 字段名与权限均已通过实测确认（Tushare 官方文档 + 真实调用）：
// - daily：基础积分每分钟 500 次、单次 6000 行，官方建议「循环日期」而非「循环 ts_code」
// - daily_basic / fina_indicator / top10_floatholders / stk_holdernumber：≥2000 积分
// - fina_indicator 单只股票单次最多 100 条，且同一 end_date 可能出现重复行（须去重）

import { callTushare } from "../_tushare";
import { CanSlimError } from "./types";
import type {
  StockBasicRow,
  DailyRow,
  AdjFactorRow,
  DailyBasicRow,
  IndexDailyRow,
  TradeCalRow,
} from "./types";

// ===== 可注入的 callTushare 引用（便于测试 mock） =====

/** callTushare 的函数签名（与 _tushare.ts 导出保持一致） */
type CallTushareFn = <T = Record<string, unknown>>(
  api_name: string,
  params?: Record<string, unknown>,
  fields?: string
) => Promise<T[]>;

let callTushareImpl: CallTushareFn = callTushare;

/** 注入自定义 callTushare 实现（仅供测试使用） */
export function __setCallTushare(fn: CallTushareFn): void {
  callTushareImpl = fn;
}

/** 恢复为真实 callTushare 实现（仅供测试使用） */
export function __resetCallTushare(): void {
  callTushareImpl = callTushare;
}

// ===== 策略常量 =====

/** 默认单次调用超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 瞬时错误最大重试次数（不含首次） */
export const DEFAULT_MAX_RETRIES = 3;
/** 瞬时错误重试间隔（毫秒） */
export const RETRY_INTERVAL_MS = 1_000;
/** 命中频控后的退避基数（毫秒）：第 n 次退避 = 基数 × n */
export const RATE_LIMIT_BACKOFF_MS = 15_000;
/** 频控最大退避次数 */
export const RATE_LIMIT_MAX_RETRIES = 4;

/** 默认最小调用间隔（毫秒）。daily 允许 500 次/分钟 ≈ 120ms/次，默认留余量 */
let minCallIntervalMs = 150;

/**
 * 各接口独立的最小调用间隔（毫秒）。
 *
 * Tushare 的频率限制是按接口分别计算的，且差异很大。实测确认：
 * - daily：500 次/分钟（官方文档明示）
 * - fina_indicator：200 次/分钟（实测触发 40203，错误信息明确写出该限额）
 *
 * 逐只取数的接口按 200 次/分钟保守设置为 350ms（≈171 次/分钟，留 15% 余量）。
 * 这里的节流是「按接口串行化发起时刻」，因此无论调用方用多少并发，
 * 总速率都不会超过 1000/interval 次每分钟。
 */
const API_MIN_INTERVAL_MS: Record<string, number> = {
  fina_indicator: 350,
  top10_floatholders: 350,
  stk_holdernumber: 350,
  income: 350,
};

/** 每个接口上一次发起调用的时间戳（限额按接口独立计算，故分开记录） */
const lastCallAtByApi = new Map<string, number>();

/** 设置默认最小调用间隔（同步脚本可按账号积分调整） */
export function setMinCallInterval(ms: number): void {
  minCallIntervalMs = Math.max(0, ms);
}

/** 读取当前默认最小调用间隔 */
export function getMinCallInterval(): number {
  return minCallIntervalMs;
}

/** 覆盖某个接口的最小调用间隔 */
export function setApiMinInterval(apiName: string, ms: number): void {
  API_MIN_INTERVAL_MS[apiName] = Math.max(0, ms);
}

/** 取某接口生效的最小调用间隔 */
function intervalFor(apiName: string): number {
  return API_MIN_INTERVAL_MS[apiName] ?? minCallIntervalMs;
}

/** 权限/积分不足的识别关键字（命中即不重试） */
const PERMISSION_KEYWORDS = ["权限", "积分", "没有接口访问权限", "请联系"];
/**
 * 频率限制的识别关键字（命中则退避重试）。
 * 实测 fina_indicator 超限时返回错误码 40203，文案为「频率超限(200次/分钟)」。
 */
const RATE_LIMIT_KEYWORDS = [
  "每分钟",
  "频率",
  "频次",
  "访问该接口的次数",
  "40203",
  "超限",
];

// ===== 内部工具 =====

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 判定是否为频控错误（先于权限判定，因为频控文案里也可能含「积分」） */
function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err);
  return RATE_LIMIT_KEYWORDS.some((kw) => msg.includes(kw));
}

/** 判定是否为权限/积分不足错误 */
function isPermissionError(err: unknown): boolean {
  if (isRateLimitError(err)) return false;
  const msg = errorMessage(err);
  return PERMISSION_KEYWORDS.some((kw) => msg.includes(kw));
}

/** 判定是否为瞬时错误（网络抖动、超时、HTTP 5xx） */
function isTransientError(err: unknown): boolean {
  if (err instanceof CanSlimError && err.kind === "timeout") return true;
  const msg = errorMessage(err);
  if (/HTTP error:\s*5\d\d/i.test(msg)) return true;
  return /network|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timeout|超时/i.test(
    msg
  );
}

/** 单次调用施加超时 */
function callWithTimeout<T>(
  apiName: string,
  params: Record<string, unknown>,
  fields: string,
  timeoutMs: number
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new CanSlimError(`接口 ${apiName} 调用超时（${timeoutMs}ms）`, apiName, "timeout")
      );
    }, timeoutMs);

    callTushareImpl<T>(apiName, params, fields).then(
      (rows) => {
        clearTimeout(timer);
        resolve(rows);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 按接口的最小间隔节流。
 *
 * 关键点：先占位再等待。并发调用时每个请求都会拿到一个递增的「发起时刻」，
 * 从而把并发请求串成固定速率，而不是让它们同时读到相同的 lastCallAt 后一起放行。
 */
async function throttle(apiName: string): Promise<void> {
  const interval = intervalFor(apiName);
  if (interval <= 0) return;

  const now = Date.now();
  const last = lastCallAtByApi.get(apiName) ?? 0;
  const scheduled = Math.max(now, last + interval);
  lastCallAtByApi.set(apiName, scheduled);

  const wait = scheduled - now;
  if (wait > 0) await sleep(wait);
}

/**
 * 带节流、超时、重试与错误分类的取数入口。
 *
 * 错误处理分层：
 * - 频控：退避 RATE_LIMIT_BACKOFF_MS × 次数后重试，最多 RATE_LIMIT_MAX_RETRIES 次
 * - 权限不足：立即抛 kind='permission'，不重试（上层据此做因子降级）
 * - 瞬时错误：间隔 1s 重试，最多 DEFAULT_MAX_RETRIES 次
 * - 其它：立即抛出，携带失败接口名
 */
export async function fetchWithPolicy<T>(
  apiName: string,
  params: Record<string, unknown>,
  fields = "",
  opts?: { timeoutMs?: number; maxRetries?: number }
): Promise<T[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: unknown;
  let transientAttempts = 0;
  let rateLimitAttempts = 0;

  // 循环上限取两类重试之和加一，避免极端情况下无限循环
  const hardLimit = maxRetries + RATE_LIMIT_MAX_RETRIES + 1;

  for (let i = 0; i < hardLimit; i++) {
    try {
      await throttle(apiName);
      return await callWithTimeout<T>(apiName, params, fields, timeoutMs);
    } catch (err) {
      lastError = err;

      // 频控：退避后重试，同时自动降速
      if (isRateLimitError(err) && rateLimitAttempts < RATE_LIMIT_MAX_RETRIES) {
        rateLimitAttempts++;
        // 提高该接口的最小间隔，避免退避结束后立刻再次撞限。
        // 之所以自适应而不是固定值：不同账号的积分对应不同限额，
        // 与其猜一个保守值拖慢所有人，不如撞到之后再降速。
        const widened = Math.ceil(intervalFor(apiName) * 1.5);
        setApiMinInterval(apiName, widened);

        const backoff = RATE_LIMIT_BACKOFF_MS * rateLimitAttempts;
        console.warn(
          `[can-slim] 接口 ${apiName} 命中频率限制，调用间隔已提升至 ${widened}ms，` +
            `退避 ${backoff / 1000}s 后重试（第 ${rateLimitAttempts} 次）`
        );
        await sleep(backoff);
        continue;
      }

      // 权限/积分不足：不重试
      if (isPermissionError(err)) {
        throw new CanSlimError(
          `接口 ${apiName} 权限不足：${errorMessage(err)}`,
          apiName,
          "permission"
        );
      }

      // 瞬时错误：短间隔重试
      if (isTransientError(err) && transientAttempts < maxRetries) {
        transientAttempts++;
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      break;
    }
  }

  const kind =
    lastError instanceof CanSlimError && lastError.kind === "timeout"
      ? "timeout"
      : isRateLimitError(lastError)
        ? "rate-limit"
        : "generic";
  throw new CanSlimError(
    `接口 ${apiName} 调用失败：${errorMessage(lastError)}`,
    apiName,
    kind
  );
}

// ===== 数值规范化 =====

/** 转为数字；null/undefined/空串/非数值一律返回 0（行情量价字段） */
function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 转为数字或 null（用于「缺失」与「0」语义不同的字段） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 转为字符串；null/undefined 返回空串 */
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// ===== 各接口封装 =====

/**
 * 获取交易日历（仅开市日）。
 * @param exchange 交易所，默认 SSE
 */
export async function fetchTradeCal(
  startDate: string,
  endDate: string,
  exchange = "SSE"
): Promise<TradeCalRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "trade_cal",
    { exchange, start_date: startDate, end_date: endDate, is_open: "1" },
    "exchange,cal_date,is_open,pretrade_date"
  );
  return rows
    .map((r) => ({
      exchange: str(r.exchange),
      cal_date: str(r.cal_date),
      is_open: num(r.is_open),
      pretrade_date: r.pretrade_date ? str(r.pretrade_date) : null,
    }))
    .sort((a, b) => a.cal_date.localeCompare(b.cal_date));
}

/** 获取全量上市股票列表（含 industry / market / list_date） */
export async function fetchStockBasic(): Promise<StockBasicRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "stock_basic",
    { list_status: "L" },
    "ts_code,name,industry,market,list_date"
  );
  if (rows.length === 0) {
    throw new CanSlimError("stock_basic 返回空列表", "stock_basic", "empty");
  }
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    name: str(r.name),
    industry: str(r.industry),
    market: str(r.market),
    list_date: str(r.list_date),
  }));
}

/** 按交易日获取全市场不复权日线截面（停牌股当日无数据，属正常） */
export async function fetchDailyByDate(tradeDate: string): Promise<DailyRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "daily",
    { trade_date: tradeDate },
    "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount"
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    trade_date: str(r.trade_date),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    pre_close: num(r.pre_close),
    pct_chg: num(r.pct_chg),
    vol: num(r.vol),
    amount: num(r.amount),
  }));
}

/** 按交易日获取全市场复权因子截面 */
export async function fetchAdjFactorByDate(tradeDate: string): Promise<AdjFactorRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "adj_factor",
    { trade_date: tradeDate },
    "ts_code,trade_date,adj_factor"
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    trade_date: str(r.trade_date),
    adj_factor: num(r.adj_factor),
  }));
}

/** 按交易日获取全市场每日指标截面（含自由流通口径与涨跌停状态） */
export async function fetchDailyBasicByDate(tradeDate: string): Promise<DailyBasicRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "daily_basic",
    { trade_date: tradeDate },
    "ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,float_share,free_share,circ_mv,total_mv,limit_status"
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    trade_date: str(r.trade_date),
    close: num(r.close),
    turnover_rate: num(r.turnover_rate),
    turnover_rate_f: num(r.turnover_rate_f),
    volume_ratio: num(r.volume_ratio),
    float_share: num(r.float_share),
    free_share: num(r.free_share),
    circ_mv: num(r.circ_mv),
    total_mv: num(r.total_mv),
    limit_status: numOrNull(r.limit_status),
  }));
}

/** 获取单个指数的日线区间数据（单次上限 8000 行，3 年约 730 行，一次调用即可） */
export async function fetchIndexDaily(
  tsCode: string,
  startDate: string,
  endDate: string
): Promise<IndexDailyRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "index_daily",
    { ts_code: tsCode, start_date: startDate, end_date: endDate },
    "ts_code,trade_date,open,high,low,close,pct_chg,vol,amount"
  );
  return rows
    .map((r) => ({
      ts_code: str(r.ts_code),
      trade_date: str(r.trade_date),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      pct_chg: num(r.pct_chg),
      vol: num(r.vol),
      amount: num(r.amount),
    }))
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

// ===== 财务与股东数据（C / A / I 因子） =====

/**
 * fina_indicator 原始行（字段已按实测确认，q_* 单季字段必须显式列在 fields 里，
 * 因为它们在接口文档中的「默认显示」为否）。
 */
export interface FinaIndicatorRow {
  ts_code: string;
  end_date: string;
  ann_date: string;
  eps: number | null;
  dt_eps: number | null;
  profit_dedt: number | null;
  roe: number | null;
  roe_waa: number | null;
  roe_dt: number | null;
  grossprofit_margin: number | null;
  netprofit_margin: number | null;
  basic_eps_yoy: number | null;
  dt_netprofit_yoy: number | null;
  netprofit_yoy: number | null;
  or_yoy: number | null;
  tr_yoy: number | null;
  q_eps: number | null;
  q_dtprofit: number | null;
  q_sales_yoy: number | null;
  q_netprofit_yoy: number | null;
  q_profit_yoy: number | null;
  q_gr_yoy: number | null;
  q_dt_roe: number | null;
  debt_to_assets: number | null;
  update_flag: string;
}

/** fina_indicator 需要的字段清单 */
const FINA_INDICATOR_FIELDS = [
  "ts_code",
  "ann_date",
  "end_date",
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
].join(",");

/**
 * 获取单只股票的财务指标（单次上限 100 条，覆盖 4 年约 16~20 个报告期，一次调用足够）。
 *
 * 注意：本接口只按单只股票取数（按报告期取全市场需要 fina_indicator_vip 与 5000 积分），
 * 因此必须放在候选集缩小之后调用。
 */
export async function fetchFinaIndicator(
  tsCode: string,
  startDate: string,
  endDate: string
): Promise<FinaIndicatorRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "fina_indicator",
    { ts_code: tsCode, start_date: startDate, end_date: endDate },
    FINA_INDICATOR_FIELDS
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    end_date: str(r.end_date),
    // ann_date 缺失时用 end_date 兜底并推迟一个季度，避免把未披露数据当成已可见
    ann_date: r.ann_date ? str(r.ann_date) : "",
    eps: numOrNull(r.eps),
    dt_eps: numOrNull(r.dt_eps),
    profit_dedt: numOrNull(r.profit_dedt),
    roe: numOrNull(r.roe),
    roe_waa: numOrNull(r.roe_waa),
    roe_dt: numOrNull(r.roe_dt),
    grossprofit_margin: numOrNull(r.grossprofit_margin),
    netprofit_margin: numOrNull(r.netprofit_margin),
    basic_eps_yoy: numOrNull(r.basic_eps_yoy),
    dt_netprofit_yoy: numOrNull(r.dt_netprofit_yoy),
    netprofit_yoy: numOrNull(r.netprofit_yoy),
    or_yoy: numOrNull(r.or_yoy),
    tr_yoy: numOrNull(r.tr_yoy),
    q_eps: numOrNull(r.q_eps),
    q_dtprofit: numOrNull(r.q_dtprofit),
    q_sales_yoy: numOrNull(r.q_sales_yoy),
    q_netprofit_yoy: numOrNull(r.q_netprofit_yoy),
    q_profit_yoy: numOrNull(r.q_profit_yoy),
    q_gr_yoy: numOrNull(r.q_gr_yoy),
    q_dt_roe: numOrNull(r.q_dt_roe),
    debt_to_assets: numOrNull(r.debt_to_assets),
    update_flag: str(r.update_flag),
  }));
}

/** top10_floatholders 原始行 */
export interface Top10FloatHolderRow {
  ts_code: string;
  end_date: string;
  ann_date: string;
  holder_name: string;
  hold_amount: number | null;
  hold_ratio: number | null;
  hold_float_ratio: number | null;
  /** 持股变动；null 表示新进 */
  hold_change: number | null;
  holder_type: string;
}

/**
 * 获取单只股票的前十大流通股东。
 *
 * holder_type 的实测取值为「投资公司 / 一般企业 / 自然人 / 开放式投资基金 /
 * 其他金融产品 / 风险投资公司」，并非标准机构分类，
 * 因此机构识别需要 holder_type 白名单叠加 holder_name 关键词（见 i-institution.ts）。
 */
export async function fetchTop10FloatHolders(
  tsCode: string,
  startDate: string,
  endDate: string
): Promise<Top10FloatHolderRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "top10_floatholders",
    { ts_code: tsCode, start_date: startDate, end_date: endDate },
    "ts_code,ann_date,end_date,holder_name,hold_amount,hold_ratio,hold_float_ratio,hold_change,holder_type"
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    end_date: str(r.end_date),
    ann_date: r.ann_date ? str(r.ann_date) : "",
    holder_name: str(r.holder_name),
    hold_amount: numOrNull(r.hold_amount),
    hold_ratio: numOrNull(r.hold_ratio),
    hold_float_ratio: numOrNull(r.hold_float_ratio),
    hold_change: numOrNull(r.hold_change),
    holder_type: str(r.holder_type),
  }));
}

/** stk_holdernumber 原始行 */
export interface HolderNumberRow {
  ts_code: string;
  end_date: string;
  ann_date: string;
  holder_num: number | null;
}

/**
 * 按公告日期区间批量获取股东户数。
 *
 * 该接口的 ts_code 为非必选，可按公告日期批量拉全市场，成本远低于逐只拉取。
 * 但实测单次返回会被截断（一个较宽区间只覆盖部分股票），
 * 因此调用方需按较窄的公告窗口分段拉取（见 financials.ts 的 ensureHolderNumbers）。
 */
export async function fetchHolderNumbers(
  startDate: string,
  endDate: string
): Promise<HolderNumberRow[]> {
  const rows = await fetchWithPolicy<Record<string, unknown>>(
    "stk_holdernumber",
    { start_date: startDate, end_date: endDate },
    "ts_code,ann_date,end_date,holder_num"
  );
  return rows.map((r) => ({
    ts_code: str(r.ts_code),
    end_date: str(r.end_date),
    ann_date: r.ann_date ? str(r.ann_date) : "",
    holder_num: numOrNull(r.holder_num),
  }));
}
