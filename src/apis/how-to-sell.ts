import { computeSellAdvice } from "./sell-advisor/service";
import { ValidationError } from "./sell-advisor/types";

/**
 * POST /api/how-to-sell
 * 我的股票合适卖：接收持仓表单（code、cost、position、可选 buy_date），
 * 计算并返回结构化卖出建议 SellAdvice。
 *
 * 响应格式沿用 { code, data }：
 * - 请求体非合法 JSON：{ code: -1, message } + HTTP 400（需求 11.5）。
 * - 成功：{ code: 0, data } + HTTP 200（需求 11.1、11.2）。
 * - 输入校验失败（ValidationError）：{ code: -1, message } + HTTP 400（需求 11.5）。
 * - 其余计算/接口错误：{ code: -1, message } + HTTP 500（需求 11.6）。
 */
export const route = {
  "/api/how-to-sell": {
    async POST(req: Request) {
      // 先解析请求体；非合法 JSON 直接返回 400，不进入业务计算
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { code: -1, message: "请求体不是合法 JSON" },
          { status: 400 }
        );
      }

      try {
        // 端到端计算卖出建议；成功返回 code 0（需求 11.1、11.2）
        const data = await computeSellAdvice(body);
        return Response.json({ code: 0, data });
      } catch (err) {
        // 输入非法 → 400（需求 11.5）；其余计算/接口错误 → 500（需求 11.6）
        const status = err instanceof ValidationError ? 400 : 500;
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ code: -1, message }, { status });
      }
    },
  },
};
