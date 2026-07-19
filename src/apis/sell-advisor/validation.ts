// 输入校验（纯函数）
// 需求 1.3、1.4、1.5、1.6、1.10：校验 Position_Input 并规范化为含 full_code 的 NormalizedInput。
// 校验失败时抛出 ValidationError（由 HTTP 层转为 400）。

import { toFullCode } from "./code";
import { type NormalizedInput, ValidationError } from "./types";

// 各字段校验失败时的固定提示（对照 design.md 错误处理表）
const CODE_MSG = "请输入 6 位沪深主板股票代码";
const COST_MSG = "成本价必须为 0.01 至 999999.99 之间且最多两位小数的数值";
const POSITION_MSG = "持仓数量必须为 1 至 9999999999 之间的整数";
const BUY_DATE_MSG = "买入日期无效";

// 数值边界常量
const COST_MIN = 0.01;
const COST_MAX = 999999.99;
const POSITION_MIN = 1;
const POSITION_MAX = 9999999999;
const BUY_DATE_MIN = 19901219; // 沪深最早可交易日期下限

/**
 * 将本地"今日"格式化为 YYYYMMDD 整数，用于买入日期上界比较（需求 1.6）。
 */
function todayYyyymmdd(): number {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return y * 10000 + m * 100 + d;
}

/**
 * 校验 code 并返回补全后的 full_code。
 * 规则：字符串、6 位纯数字、且可映射沪深主板后缀（需求 1.3、1.10）。
 */
function validateCode(raw: unknown): { code: string; full_code: string } {
  if (typeof raw !== "string") {
    throw new ValidationError(CODE_MSG);
  }
  const code = raw.trim();
  const full_code = toFullCode(code);
  if (full_code === null) {
    throw new ValidationError(CODE_MSG);
  }
  return { code, full_code };
}

/**
 * 校验 cost：接受数字或数字字符串，转换为数值后要求
 * 0.01 ≤ cost ≤ 999999.99 且小数位 ≤ 2（需求 1.4）。
 */
function validateCost(raw: unknown): number {
  let numStr: string;
  if (typeof raw === "number") {
    // 拒绝 NaN / Infinity
    if (!Number.isFinite(raw)) {
      throw new ValidationError(COST_MSG);
    }
    numStr = String(raw);
  } else if (typeof raw === "string") {
    numStr = raw.trim();
    if (numStr === "") {
      throw new ValidationError(COST_MSG);
    }
  } else {
    throw new ValidationError(COST_MSG);
  }

  // 仅接受正的十进制数值，且小数位不超过 2（借由字符串形式精确判定小数位）
  if (!/^\d+(\.\d{1,2})?$/.test(numStr)) {
    throw new ValidationError(COST_MSG);
  }

  const value = Number(numStr);
  if (value < COST_MIN || value > COST_MAX) {
    throw new ValidationError(COST_MSG);
  }
  return value;
}

/**
 * 校验 position：接受整数或整数字符串，要求
 * 1 ≤ position ≤ 9999999999 的整数（需求 1.5）。
 */
function validatePosition(raw: unknown): number {
  let numStr: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new ValidationError(POSITION_MSG);
    }
    numStr = String(raw);
  } else if (typeof raw === "string") {
    numStr = raw.trim();
    if (numStr === "") {
      throw new ValidationError(POSITION_MSG);
    }
  } else {
    throw new ValidationError(POSITION_MSG);
  }

  // 仅接受正整数（无符号、无小数、无指数）
  if (!/^\d+$/.test(numStr)) {
    throw new ValidationError(POSITION_MSG);
  }

  const value = Number(numStr);
  // 防御超大数值导致精度丢失后仍被误判为整数
  if (!Number.isInteger(value) || value < POSITION_MIN || value > POSITION_MAX) {
    throw new ValidationError(POSITION_MSG);
  }
  return value;
}

/**
 * 校验可选 buy_date：未提供（undefined/null/空串）时返回 undefined；
 * 若提供，须为合法 YYYYMMDD 且 19901219 ≤ buy_date ≤ 今日（需求 1.6）。
 */
function validateBuyDate(raw: unknown): string | undefined {
  // 未填写视为未提供
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ValidationError(BUY_DATE_MSG);
  }
  const s = raw.trim();
  if (s === "") {
    return undefined;
  }
  if (!/^\d{8}$/.test(s)) {
    throw new ValidationError(BUY_DATE_MSG);
  }

  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));

  // 校验为真实存在的日历日期（排除如 20230230 等）
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    throw new ValidationError(BUY_DATE_MSG);
  }

  const num = Number(s);
  if (num < BUY_DATE_MIN || num > todayYyyymmdd()) {
    throw new ValidationError(BUY_DATE_MSG);
  }
  return s;
}

/**
 * 校验 Position_Input；通过返回规范化输入（含 full_code），否则抛 ValidationError。
 *
 * 校验顺序：code → cost → position → buy_date（任一不通过立即抛错）。
 *
 * @param raw 前端提交的原始持仓输入（未校验）
 * @returns 规范化后的持仓输入 NormalizedInput
 * @throws {ValidationError} 任一字段校验失败（需求 1.3–1.6、1.10）
 */
export function validatePositionInput(raw: unknown): NormalizedInput {
  // 非对象输入按缺失 code 处理
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError(CODE_MSG);
  }
  const obj = raw as Record<string, unknown>;

  const { code, full_code } = validateCode(obj.code);
  const cost = validateCost(obj.cost);
  const position = validatePosition(obj.position);
  const buy_date = validateBuyDate(obj.buy_date);

  const result: NormalizedInput = { code, full_code, cost, position };
  if (buy_date !== undefined) {
    result.buy_date = buy_date;
  }
  return result;
}
