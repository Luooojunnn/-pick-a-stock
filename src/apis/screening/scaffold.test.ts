// 脚手架冒烟测试：验证 bun test 与 fast-check 均可正常运行
// 该文件仅用于确认测试环境搭建成功，后续实现各筛选模块时可移除

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

describe("测试脚手架", () => {
  // 验证 bun test 运行器可用
  test("bun test 可运行", () => {
    expect(1 + 1).toBe(2);
  });

  // 验证 fast-check 属性测试可运行（示例属性：加法交换律）
  test("fast-check 可运行", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });
});
