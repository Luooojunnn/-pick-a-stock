import { callTushare } from "./_tushare";

interface StockBasic {
  ts_code: string;
  name: string;
  area: string;
  industry: string;
  list_date: string;
}

/**
 * GET /api/stock/basic
 * 查询股票基本信息列表
 * 可选 query 参数: list_status (L=上市 D=退市 P=暂停, 默认 L)
 */
export const route = {
  "/api/stock/basic": {
    async GET(req: Request) {
      try {
        const url = new URL(req.url);
        const list_status = url.searchParams.get("list_status") ?? "L";

        const data = await callTushare<StockBasic>(
          "stock_basic",
          { list_status },
          "ts_code,name,area,industry,list_date"
        );

        return Response.json({ code: 0, data });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ code: -1, message }, { status: 500 });
      }
    },
  },
};
