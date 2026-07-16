import tushareConfig from "../../tushareConfig.json";

const TUSHARE_API_URL = "http://api.tushare.pro";

interface TushareResponse {
  code: number;
  msg: string;
  data: {
    fields: string[];
    items: unknown[][];
  };
}

/**
 * 调用 Tushare 接口的通用函数
 * 自动将 fields + items 格式转换为对象数组
 */
export async function callTushare<T = Record<string, unknown>>(
  api_name: string,
  params: Record<string, unknown> = {},
  fields: string = ""
): Promise<T[]> {
  const body = {
    api_name,
    token: tushareConfig.token,
    params,
    fields,
  };

  const res = await fetch(TUSHARE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Tushare HTTP error: ${res.status} ${res.statusText}`);
  }

  const json: TushareResponse = await res.json();

  if (json.code !== 0) {
    throw new Error(`Tushare API error [${json.code}]: ${json.msg}`);
  }

  const { fields: fieldNames, items } = json.data;

  // 将 [["000001.SZ", "平安银行", ...], ...] 转为 [{ ts_code: "000001.SZ", name: "平安银行", ... }, ...]
  return items.map(row =>
    Object.fromEntries(fieldNames.map((key, i) => [key, row[i]]))
  ) as T[];
}
