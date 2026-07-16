// Feature: daily-stock-screening, Property 8: 成交量递增分级判定与互斥
// Validates: Requirements 6.2, 6.3, 6.4
//
// 生成随机正数三元组 (v1, v2, v3)（含相等边界），调用 classifyVolume 后断言：
// - 严格递增（v1 < v2 < v3）→ keep 且 grade="理想条件"
// - 非严格递增（v1 <= v2 <= v3）但非严格 → keep 且 grade="放宽条件"
// - 其余（未递增）→ keep 为 false
// 并断言分级结果绝不同时为两个标注（decision 只有单个 grade 字段，取值互斥）。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { classifyVolume } from "./volume-increasing";

// 生成正数成交量（手）：有限、严格大于 0，覆盖较小与较大量级
const positiveVol = fc.double({
  noNaN: true,
  noDefaultInfinity: true,
  min: 1e-6,
  max: 1e9,
});

describe("Property 8: 成交量递增分级判定与互斥", () => {
  // 主属性：分级判定正确，且分级取值互斥（绝不同时具"理想条件"与"放宽条件"）
  test("分级正确且绝不同时具两个标注", () => {
    fc.assert(
      fc.property(positiveVol, positiveVol, positiveVol, (v1, v2, v3) => {
        const decision = classifyVolume([v1, v2, v3]);

        const strictlyIncreasing = v1 < v2 && v2 < v3;
        const nonStrictlyIncreasing = v1 <= v2 && v2 <= v3;

        if (strictlyIncreasing) {
          // 严格递增 → 保留并仅标"理想条件"（需求 6.2）
          expect(decision.keep).toBe(true);
          if (decision.keep) {
            expect(decision.grade).toBe("理想条件");
          }
        } else if (nonStrictlyIncreasing) {
          // 非严格递增但非严格 → 保留并仅标"放宽条件"（需求 6.3）
          expect(decision.keep).toBe(true);
          if (decision.keep) {
            expect(decision.grade).toBe("放宽条件");
          }
        } else {
          // 未递增 → 排除（需求 6.4）
          expect(decision.keep).toBe(false);
        }

        // 互斥性：保留时 grade 为单一取值，绝不同时为两个标注
        if (decision.keep) {
          expect(["理想条件", "放宽条件"]).toContain(decision.grade);
          // grade 是单个字段，取值二选一，天然互斥
          expect(decision.grade === "理想条件" && decision.grade === "放宽条件").toBe(false);
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });

  // 相等边界属性：显式覆盖含相等的非严格递增（如 v1 == v2 或 v2 == v3）→ 放宽条件
  test("含相等的非严格递增标注为放宽条件", () => {
    fc.assert(
      fc.property(
        positiveVol,
        positiveVol,
        fc.constantFrom("eq12", "eq23", "eqall"),
        (a, b, mode) => {
          // 构造非严格递增但非严格的三元组（至少存在一处相等）
          let v1: number, v2: number, v3: number;
          if (mode === "eq12") {
            // v1 == v2 <= v3
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            v1 = lo;
            v2 = lo;
            v3 = hi;
          } else if (mode === "eq23") {
            // v1 <= v2 == v3
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            v1 = lo;
            v2 = hi;
            v3 = hi;
          } else {
            // v1 == v2 == v3（全相等）
            v1 = a;
            v2 = a;
            v3 = a;
          }

          const decision = classifyVolume([v1, v2, v3]);
          expect(decision.keep).toBe(true);
          if (decision.keep) {
            expect(decision.grade).toBe("放宽条件");
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
