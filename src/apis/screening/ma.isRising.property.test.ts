// Feature: daily-stock-screening, Property 11: 均线向上判定（严格大于，含相等边界）
// Validates: Requirements 7.2
//
// 属性：isRising(today, prev) 为真，当且仅当 today 与 prev 均非 null 且 today > prev。
// 覆盖相等边界（today === prev 判为不向上）与 null 情形（任一为 null 判为不向上）。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isRising } from "./ma";

describe("isRising 属性测试", () => {
  // Property 11：随机数值对（含相等、null）验证严格大于语义
  test("isRising 为真当且仅当 today>prev 且两值均非 null", () => {
    // 生成可能为 null 的数值，覆盖 null 情形
    const nullableNumber = fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ noNaN: true })
    );

    fc.assert(
      fc.property(nullableNumber, nullableNumber, (today, prev) => {
        // 期望值：仅当两值均非 null 且 today 严格大于 prev
        const expected = today != null && prev != null && today > prev;
        expect(isRising(today, prev)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  // Property 11：相等边界专项覆盖（today === prev 必判为不向上）
  test("相等边界：today === prev 判为不向上", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (v) => {
        expect(isRising(v, v)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
