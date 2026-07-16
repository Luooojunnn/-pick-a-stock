import { runScreening } from "./screening/service";

/**
 * GET /api/daily-recommendations
 * 每日多条件选股：对沪深主板股票执行量价与均线筛选，返回候选股票列表。
 *
 * 响应格式沿用 { code, data }：
 * - 成功：code 为 0，data 为候选股票数组（可为空，需求 9.3、9.4）。
 * - 失败：code 为 -1，携带失败原因 message，HTTP 状态 500，且不返回任何部分结果（需求 9.5）。
 */
export const route = {
  "/api/daily-recommendations": {
    async GET(_req: Request) {
      // 诊断日志：按引用传入 runScreening，各阶段进度写入其中；
      // 即使中途抛错，logs 仍保留已完成阶段，便于前端定位失败环节。
      const logs: string[] = [];
      try {
        const data = await runScreening(logs);
        return Response.json({ code: 0, data, logs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logs.push(`❌ 出错：${message}`);
        // 打印到服务端控制台，附完整栈与已完成阶段日志，便于排查
        console.error("[screening] 筛选失败：", err);
        console.error("[screening] 阶段日志：\n" + logs.join("\n"));
        return Response.json({ code: -1, message, logs }, { status: 500 });
      }
    },
  },
};
