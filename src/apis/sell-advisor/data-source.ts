// 数据获取层（data-source.ts）
// 封装卖出策略所需的 Tushare 历史日线行情调用，统一处理单次调用超时、
// 瞬时错误重试与权限不足识别。
// 对应 design.md「Components and Interfaces」第 4 节「历史行情获取（data-source.ts）」
// 与「Error Handling」章节，以及需求 2.1、2.2、2.6、2.7。
//
// 关键约束：
// - 仅调用 daily / pro_bar，绝不调用任何实时 rt_* 接口（需求 2.7）。
// - 单次调用施加 30s 超时（需求 2.6）。
// - 瞬时错误（网络抖动、超时、HTTP 5xx）最多重试 3 次，相邻重试间隔 ≥ 1 秒（需求 2.6）。
// - 权限不足不重试，立即抛出权限类 SellAdvisorError（参考 screening 10.6）。
// - 失败时携带失败接口名与失败原因（需求 2.6）。
// - 回溯自然日区间覆盖 ≥ 75 个交易日以满足 MA60 + ATR14 计算需要（需求 2.2）。

import { callTushare } from "../_tushare";
import { SellAdvisorError } from "./types";
import type { DailyBar } from "./types";

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

/** 默认单次调用超时（毫秒）——需求 2.6 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 瞬时错误的最大重试次数（不含首次）——需求 2.6 */
export const DEFAULT_MAX_RETRIES = 3;
/** 相邻重试的最小间隔（毫秒）——需求 2.6：至少 1 秒 */
export const RETRY_INTERVAL_MS = 1_000;
/** 历史回溯的自然日跨度：约 120 自然日以覆盖 ≥ 75 个交易日（需求 2.2） */
export const LOOKBACK_DAYS = 120;

/** 权限不足类错误的识别关键字（命中任一即判定为权限问题，不重试） */
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

/** 判定是否为权限不足类错误（不重试） */
function isPermissionError(err: unknown): boolean {
  const msg = errorMessage(err);
  return PERMISSION_KEYWORDS.some((kw) => msg.includes(kw));
}

/** 判定是否为瞬时错误（网络抖动、超时、HTTP 5xx），可重试——需求 2.6 */
function isTransientError(err: unknown): boolean {
  // 由本层产生的超时错误（kind='timeout'）视为瞬时错误
  if (err instanceof SellAdvisorError && err.kind === "timeout") return true;
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
 * 超时后 abort 并抛出 kind='timeout' 的 SellAdvisorError；
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
        new SellAdvisorError(
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
 * 策略（需求 2.6）：
 * - 每次调用施加超时（默认 30s，可经 opts.timeoutMs 覆盖）。
 * - 权限不足错误：不重试，立即抛出 kind='permission' 的 SellAdvisorError。
 * - 瞬时错误（网络/超时/5xx）：最多重试 opts.maxRetries 次（默认 3），相邻间隔 ≥ 1 秒。
 * - 非瞬时错误或重试耗尽：抛出 SellAdvisorError，apiName 携带失败接口名与原因。
 *
 * @param apiName Tushare 接口名（仅允许 daily / pro_bar）
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

      // 权限不足：不重试，立即中止（参考 screening 10.6）
      if (isPermissionError(err)) {
        throw new SellAdvisorError(
          `接口 ${apiName} 权限不足：${errorMessage(err)}`,
          apiName,
          "permission"
        );
      }

      // 瞬时错误且仍有重试机会：等待 ≥1s 后重试（需求 2.6）
      if (isTransientError(err) && attempt < maxRetries) {
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // 非瞬时错误，或重试已耗尽：中止并抛出携带接口名的错误（需求 2.6）
      break;
    }
  }

  // 走到这里说明失败：区分超时与其它，统一携带失败接口名与原因（需求 2.6）
  const kind =
    lastError instanceof SellAdvisorError && lastError.kind === "timeout"
      ? "timeout"
      : "generic";
  throw new SellAdvisorError(
    `接口 ${apiName} 调用失败：${errorMessage(lastError)}`,
    apiName,
    kind
  );
}

// ===== 日期工具 =====

/** 将 Date 格式化为 Tushare 使用的 YYYYMMDD 字符串 */
function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ===== 历史行情获取 =====

/**
 * 获取 full_code 截至最近交易日、按 trade_date 升序的历史日线行情（需求 2.1、2.2）。
 *
 * - 仅调用 `daily`，绝不调用任何实时 rt_* 接口（需求 2.7）。
 * - 回溯约 LOOKBACK_DAYS（120）自然日的区间，以覆盖 ≥ 75 个交易日，满足
 *   MA60（需 60 日）与 ATR14（需额外 14 日）的计算需要（需求 2.2）。
 * - 返回结果按 trade_date 升序排列，末位对应最近交易日（需求 2.1）。
 * - 每条记录含 trade_date、open、high、low、close、vol 字段（需求 2.1）。
 *
 * @param fullCode 带交易所后缀的完整证券代码，如 600000.SH / 000001.SZ
 */
export async function fetchDailyHistory(fullCode: string): Promise<DailyBar[]> {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - LOOKBACK_DAYS);

  const endDate = formatYmd(today);
  const startDate = formatYmd(start);

  const rows = await fetchWithPolicy<DailyBar>(
    "daily",
    { ts_code: fullCode, start_date: startDate, end_date: endDate },
    "ts_code,trade_date,open,high,low,close,vol"
  );

  // 按 trade_date 升序排列，末位对应最近交易日（需求 2.1）
  return rows
    .slice()
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}
