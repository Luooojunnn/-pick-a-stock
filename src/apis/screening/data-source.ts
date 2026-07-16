// 数据获取层（data-source.ts）
// 封装所有 Tushare 调用，统一处理超时、瞬时错误重试、权限不足识别与空结果判定。
// 对应 design.md「数据获取层（data-source.ts）」「错误处理」章节，以及需求
// 4.5、5.5、10.1、10.2、10.3、10.4、10.5、10.6。
//
// 关键约束：
// - 仅调用 stock_basic / daily / daily_basic，绝不调用任何实时 rt_* 接口（需求 10.1–10.3）。
// - 单次调用施加超时（默认 30s；换手率场景 10s，见需求 4.5）。
// - 瞬时错误（网络抖动、超时、HTTP 5xx）最多重试 3 次，相邻重试间隔 ≥ 1 秒（需求 10.5）。
// - 权限不足不重试，立即抛出权限类 ScreeningError（需求 10.6）。
// - 失败时携带失败接口名（需求 10.4）。

import { callTushare } from "../_tushare";
import { ScreeningError } from "./types";
import type { StockBasicRow, DailyRow, DailyBasicRow } from "./types";
// 本地兜底股票列表：stock_basic 有调用频率限制，接口失败/空结果时回退到此离线数据
import stockListFallback from "../../data/stock-list.json";

// ===== 可注入的 callTushare 引用（便于测试 mock） =====

/** callTushare 的函数签名（与 _tushare.ts 导出保持一致） */
type CallTushareFn = <T = Record<string, unknown>>(
  api_name: string,
  params?: Record<string, unknown>,
  fields?: string
) => Promise<T[]>;

// 模块内部持有可覆盖的实现引用，默认指向真实 callTushare。
// 测试可通过 __setCallTushare 注入 mock，以隔离网络并验证超时/重试/权限逻辑。
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

/** 默认单次调用超时（毫秒）——需求 10.4 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 换手率场景单次调用超时（毫秒）——需求 4.5 */
export const TURNOVER_TIMEOUT_MS = 10_000;
/** 瞬时错误的最大重试次数（不含首次）——需求 10.5 */
export const DEFAULT_MAX_RETRIES = 3;
/** 相邻重试的最小间隔（毫秒）——需求 10.5：至少 1 秒 */
export const RETRY_INTERVAL_MS = 1_000;
/** 历史序列拉取的批大小（方案 A：按候选分批串行拉取） */
const HISTORY_BATCH_SIZE = 5;
/** 历史序列拉取的批间间隔（毫秒），用于规避频控 */
const HISTORY_BATCH_INTERVAL_MS = 300;

/** 权限不足类错误的识别关键字（命中任一即判定为权限问题，不重试）——需求 10.6 */
const PERMISSION_KEYWORDS = [
  "权限",
  "积分",
  "访问权限",
  "没有接口访问权限",
];

// ===== 内部工具 =====

/** 休眠指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提取错误的可读消息文本 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 判定是否为权限不足类错误（不重试）——需求 10.6 */
function isPermissionError(err: unknown): boolean {
  const msg = errorMessage(err);
  return PERMISSION_KEYWORDS.some((kw) => msg.includes(kw));
}

/** 判定是否为瞬时错误（网络抖动、超时、HTTP 5xx），可重试——需求 10.5 */
function isTransientError(err: unknown): boolean {
  // 由本层产生的超时错误（kind='timeout'）视为瞬时错误
  if (err instanceof ScreeningError && err.kind === "timeout") return true;
  const msg = errorMessage(err);
  // HTTP 5xx（服务端错误）
  if (/HTTP error:\s*5\d\d/i.test(msg)) return true;
  // 网络类/超时类错误
  if (
    /network|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timeout|超时/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 对单次 callTushare 调用施加超时（使用 AbortController）。
 * 超时后 abort 并抛出 kind='timeout' 的 ScreeningError；
 * callTushare 自身的错误则原样上抛，交由上层分类处理。
 */
function callWithTimeout<T>(
  apiName: string,
  params: Record<string, unknown>,
  fields: string,
  timeoutMs: number
): Promise<T[]> {
  const controller = new AbortController();
  return new Promise<T[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      // 触发超时：中止本次调用并抛出超时错误
      controller.abort();
      reject(
        new ScreeningError(
          `接口 ${apiName} 调用超时（${timeoutMs}ms）`,
          apiName,
          "timeout"
        )
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

// ===== 核心：带策略的取数 =====

/**
 * 带超时、重试与权限识别策略的 Tushare 取数封装。
 *
 * 策略（需求 10.4/10.5/10.6、4.5、5.5）：
 * - 每次调用施加超时（默认 30s，可经 opts.timeoutMs 覆盖，如换手率场景 10s）。
 * - 权限不足错误：不重试，立即抛出 kind='permission' 的 ScreeningError。
 * - 瞬时错误（网络/超时/5xx）：最多重试 opts.maxRetries 次（默认 3），相邻间隔 ≥ 1 秒。
 * - 非瞬时错误或重试耗尽：抛出 ScreeningError，apiName 携带失败接口名。
 *
 * @param apiName Tushare 接口名（仅允许 stock_basic/daily/daily_basic）
 * @param params 调用参数
 * @param fields 需要返回的字段
 * @param opts 可选：timeoutMs（超时）、maxRetries（最大重试次数）
 */
export async function fetchWithPolicy<T>(
  apiName: string,
  params: Record<string, unknown>,
  fields: string,
  opts?: { timeoutMs?: number; maxRetries?: number }
): Promise<T[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: unknown;

  // 首次尝试 attempt=0，其后最多重试 maxRetries 次
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callWithTimeout<T>(apiName, params, fields, timeoutMs);
    } catch (err) {
      lastError = err;

      // 权限不足：不重试，立即中止（需求 10.6）
      if (isPermissionError(err)) {
        throw new ScreeningError(
          `接口 ${apiName} 权限不足：${errorMessage(err)}`,
          apiName,
          "permission"
        );
      }

      // 瞬时错误且仍有重试机会：等待 ≥1s 后重试（需求 10.5）
      if (isTransientError(err) && attempt < maxRetries) {
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // 非瞬时错误，或重试已耗尽：中止并抛出携带接口名的错误（需求 10.4）
      break;
    }
  }

  // 走到这里说明失败：区分超时与其它，统一携带失败接口名（需求 10.4）
  const kind =
    lastError instanceof ScreeningError && lastError.kind === "timeout"
      ? "timeout"
      : "generic";
  throw new ScreeningError(
    `接口 ${apiName} 调用失败：${errorMessage(lastError)}`,
    apiName,
    kind
  );
}

// ===== 各具体取数封装 =====

/**
 * 获取上市股票列表（需求 1.1、1.6）。
 * 以 list_status="L" 取全量上市股票，字段含 ts_code、name、market。
 * 空结果视为失败并抛错（需求 1.6：stock_basic 返回空列表 → 中止筛选）。
 */
/** 沪深主板代码前缀（沪市 600/601/603/605，深市 000/001/002） */
const MAIN_BOARD_PREFIXES = ["600", "601", "603", "605", "000", "001", "002"];

/**
 * 依据 ts_code 代码前缀推断板块（market）。
 * 本地兜底列表（stock-list.json）不含 market 字段，需据此补齐，
 * 以便主板筛选（isMainBoard）能正确判定。
 */
function inferMarket(tsCode: string): string {
  const code = tsCode.split(".")[0] ?? "";
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  if (code.startsWith("688") || code.startsWith("689")) return "科创板";
  if (code.startsWith("8") || code.startsWith("4")) return "北交所";
  if (MAIN_BOARD_PREFIXES.some((p) => code.startsWith(p))) return "主板";
  return "其他";
}

/**
 * 加载本地兜底股票列表并映射为 StockBasicRow。
 * 本地数据缺少 market 字段，按代码前缀推断补齐。
 */
function loadFallbackStockBasic(): StockBasicRow[] {
  const raw = stockListFallback as Array<{ ts_code: string; name: string }>;
  return raw.map((s) => ({
    ts_code: s.ts_code,
    name: s.name,
    market: inferMarket(s.ts_code),
  }));
}

/**
 * 获取上市股票列表（需求 1.1）。
 *
 * stock_basic 接口有调用频率限制，为避免频控导致整体筛选失败：
 * 当接口调用失败（频控/权限/超时/网络等）或返回空列表时，
 * 回退使用本地兜底股票列表（src/data/stock-list.json），保证筛选流程可继续。
 */
export async function fetchStockBasic(): Promise<StockBasicRow[]> {
  try {
    const rows = await fetchWithPolicy<StockBasicRow>(
      "stock_basic",
      { list_status: "L" },
      "ts_code,name,market"
    );
    // 接口返回空列表 → 回退本地兜底数据
    if (rows.length === 0) {
      return loadFallbackStockBasic();
    }
    return rows;
  } catch {
    // 接口失败（含频率限制、权限、超时、网络错误等）→ 回退本地兜底数据
    return loadFallbackStockBasic();
  }
}

/**
 * 按交易日获取全市场 daily 截面数据（需求 2.1、6.1）。
 * 注意：此处不将空结果视为错误——空数组表示该日尚无数据，
 * 由基准日探测（reference-day）据此回溯，而非中止筛选。
 */
export async function fetchDailyByDate(tradeDate: string): Promise<DailyRow[]> {
  return fetchWithPolicy<DailyRow>(
    "daily",
    { trade_date: tradeDate },
    "ts_code,trade_date,close,pct_chg,vol"
  );
}

/**
 * 按交易日获取全市场 daily_basic 截面数据（需求 3.1、4.1、5.1）。
 * 换手率场景要求 10s 超时（需求 4.5），流通市值场景要求 30s 超时（需求 5.5）；
 * 由于两者复用同一次调用，调用方可经 opts.timeoutMs 指定所需超时。
 * 同样地，空数组不视为错误，交由基准日探测判断可用性。
 */
export async function fetchDailyBasicByDate(
  tradeDate: string,
  opts?: { timeoutMs?: number; maxRetries?: number }
): Promise<DailyBasicRow[]> {
  return fetchWithPolicy<DailyBasicRow>(
    "daily_basic",
    { trade_date: tradeDate },
    "ts_code,trade_date,volume_ratio,turnover_rate,circ_mv",
    opts
  );
}

/**
 * 按候选股分批拉取历史 daily 序列（方案 A，需求 6、7）。
 * 仅对阶段 A 幸存的候选股逐个拉取其 [startDate, endDate] 区间历史，
 * 按批（HISTORY_BATCH_SIZE）串行、批间留间隔以规避频控。
 * 返回 Map：ts_code -> 按 trade_date 升序排列的 DailyRow[]。
 *
 * @param tsCodes 候选股代码列表
 * @param startDate 起始日 YYYYMMDD
 * @param endDate 截止日 YYYYMMDD
 */
export async function fetchDailyHistory(
  tsCodes: string[],
  startDate: string,
  endDate: string
): Promise<Map<string, DailyRow[]>> {
  const result = new Map<string, DailyRow[]>();

  for (let i = 0; i < tsCodes.length; i += HISTORY_BATCH_SIZE) {
    const batch = tsCodes.slice(i, i + HISTORY_BATCH_SIZE);

    // 同一批内并发拉取，控制并发规模以规避频控
    const batchRows = await Promise.all(
      batch.map((tsCode) =>
        fetchWithPolicy<DailyRow>(
          "daily",
          { ts_code: tsCode, start_date: startDate, end_date: endDate },
          "ts_code,trade_date,close,pct_chg,vol"
        )
      )
    );

    batch.forEach((tsCode, idx) => {
      // 按 trade_date 升序排列，末位对应最近交易日（基准日）
      const rows = batchRows[idx]!
        .slice()
        .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      result.set(tsCode, rows);
    });

    // 批间留间隔（最后一批之后无需等待）
    if (i + HISTORY_BATCH_SIZE < tsCodes.length) {
      await sleep(HISTORY_BATCH_INTERVAL_MS);
    }
  }

  return result;
}
