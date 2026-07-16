// ma-trend.ts 单元测试：覆盖历史 close < 11 日的数据不足边界（需求 7.7）
// 以及长度恰为 11 日的边界可评估（不抛错）。

import { describe, expect, test } from "bun:test";
import { classifyMaTrend } from "./ma-trend";

describe("classifyMaTrend 数据不足边界（需求 7.7）", () => {
  test("长度 0 → 排除且原因含“数据不足”", () => {
    const decision = classifyMaTrend([]);
    expect(decision.keep).toBe(false);
    if (decision.keep === false) {
      expect(decision.reason).toContain("数据不足");
    }
  });

  test("长度 5 → 排除且原因含“数据不足”", () => {
    const decision = classifyMaTrend([10, 11, 12, 13, 14]);
    expect(decision.keep).toBe(false);
    if (decision.keep === false) {
      expect(decision.reason).toContain("数据不足");
    }
  });

  test("长度 10 → 排除且原因含“数据不足”", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 10 + i);
    const decision = classifyMaTrend(closes);
    expect(decision.keep).toBe(false);
    if (decision.keep === false) {
      expect(decision.reason).toContain("数据不足");
    }
  });
});

describe("classifyMaTrend 长度 11 边界（需求 7.7 边界示例）", () => {
  test("长度恰为 11 日 → 可评估、不再标数据不足、不抛错", () => {
    // 递增序列 11 个点，可计算基准日与前一日的 MA5/MA10（MA10 需要 10 个点）
    const closes = Array.from({ length: 11 }, (_, i) => 10 + i);
    // 不应抛出异常
    const decision = classifyMaTrend(closes);
    // 已能评估：不再返回“数据不足”
    if (decision.keep === false) {
      expect(decision.reason).not.toContain("数据不足");
    }
    // 严格递增序列下 MA5、MA10 均向上，应保留并标注放宽条件（<61 日跳过多头排列）
    expect(decision.keep).toBe(true);
    if (decision.keep === true) {
      expect(decision.grade).toBe("放宽条件");
    }
  });
});
