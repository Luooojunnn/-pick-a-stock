// 代码补全与校验（纯函数）
// 需求 1.9、1.10：将用户输入的 6 位数字 code 补全为带交易所后缀的完整代码 full_code

/**
 * 校验并将 6 位数字 code 补全为 full_code。
 *
 * 规则：
 * - 仅接受 6 位纯数字；
 * - 首字符为 `6`（如 600/601/603/605）→ 返回 `${code}.SH`（上交所）；
 * - 首字符为 `0`（如 000/001/002/003）→ 返回 `${code}.SZ`（深交所）；
 * - 其余情况（含非 6 位、含非数字、首字符既非 6 也非 0）→ 返回 `null`。
 *
 * @param code 用户输入的股票代码（预期为 6 位纯数字，不含交易所后缀）
 * @returns 补全后的完整代码（如 `600000.SH`、`000001.SZ`），无法映射时返回 `null`
 */
export function toFullCode(code: string): string | null {
  // 仅接受 6 位纯数字，否则视为非法输入
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  // 依据首字符前缀映射交易所后缀
  const firstChar = code[0];
  if (firstChar === "6") {
    return `${code}.SH`;
  }
  if (firstChar === "0") {
    return `${code}.SZ`;
  }

  // 无法映射到沪深主板后缀
  return null;
}
