// 需求 1：沪深主板筛选（filters/main-board.ts）
// 判定某只股票是否属于沪深主板：market 严格等于"主板"，且代码前缀属于白名单；
// 同时命中排除板块（创业板/科创板/北交所）时以排除为准（排除优先于保留）。

import type { StockBasicRow } from "../types";

/** 沪深主板代码前缀白名单（需求 1.3）：沪市 600/601/603/605，深市 000/001/002 */
const MAIN_BOARD_PREFIXES = ["600", "601", "603", "605", "000", "001", "002"];

/**
 * 排除板块的代码前缀（需求 1.4）：
 * - 创业板：300 / 301
 * - 科创板：688 / 689
 * - 北交所：8 开头、4 开头
 * 说明：北交所以单字符前缀（8、4）匹配，覆盖 8xxxxx / 4xxxxx 全部代码。
 */
const CREATION_BOARD_PREFIXES = ["300", "301"];
const STAR_BOARD_PREFIXES = ["688", "689"];
const BSE_PREFIXES = ["8", "4"];

/** 从 ts_code（形如 "600000.SH"）中取出去除交易所后缀的纯数字代码 */
function getStockCode(tsCode: string): string {
  // ts_code 形如 "600000.SH"，取小数点前的数字部分作为代码前缀判断依据
  return tsCode.split(".")[0] ?? "";
}

/**
 * 判定一只股票是否属于沪深主板（纯函数）。
 *
 * 判定规则（需求 1.2 / 1.3 / 1.4）：
 * 1. 排除优先：代码前缀命中创业板 300/301、科创板 688/689、北交所 8/4 开头者，直接排除；
 * 2. 保留条件：market 严格等于"主板"，且代码前缀属于白名单 {600,601,603,605,000,001,002}。
 *
 * 排除规则相对保留规则具有绝对优先级：同时命中保留与排除条件时以排除为准。
 */
export function isMainBoard(stock: StockBasicRow): boolean {
  const code = getStockCode(stock.ts_code);

  // 步骤 1：排除优先——先判断是否命中排除板块前缀，命中则一律排除（需求 1.4）
  if (CREATION_BOARD_PREFIXES.some((p) => code.startsWith(p))) return false;
  if (STAR_BOARD_PREFIXES.some((p) => code.startsWith(p))) return false;
  if (BSE_PREFIXES.some((p) => code.startsWith(p))) return false;

  // 步骤 2：保留条件——market 必须严格等于"主板"（需求 1.2）
  if (stock.market !== "主板") return false;

  // 步骤 3：代码前缀必须属于沪深主板白名单，其余前缀一律排除（需求 1.3）
  return MAIN_BOARD_PREFIXES.some((p) => code.startsWith(p));
}
