// Feature: daily-stock-screening, Property 5: 换手率区间筛选（含端点 5、10）
// Validates: Requirements 4.2, 4.3
//
// 属性：对任意有效数值 turnover_rate，applyTurnoverRate 保留该股当且仅当
// 5 ≤ turnover_rate ≤ 10（含端点 5 与 10）；区间外一律排除。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DailyBasicRow } from "../types";
import { applyTurnoverRate } from "./turnover-rate";

/** 构造仅关心 turnover_rate 的 DailyBasicRow（其余字段填占位有效值） */
function makeRow(turnoverRate: number): DailyBasicRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    volume_ratio: 1,
    turnover_rate: turnoverRate,
    circ_mv: 1000000,
  };
}

describe("applyTurnoverRate 属性测试", () => {
  // Property 5：随机有效数值覆盖区间内外，验证 keep 语义
  test("keep 为真当且仅当 5 ≤ turnover_rate ≤ 10", () => {
    // 生成有限有效数值，范围覆盖区间内、下界外、上界外
    const turnoverRate = fc.double({ min: -50, max: 50, noNaN: true });

    fc.assert(
      fc.property(turnoverRate, (rate) => {
        const decision = applyTurnoverRate(makeRow(rate));
        const expected = rate >= 5 && rate <= 10;
        expect(decision.keep).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  // Property 5：端点专项覆盖，随机贴近 5 与 10 的取值验证含端点语义
  test("端点边界：贴近 5、10 的取值满足含端点判定", () => {
    // 在端点附近生成微小偏移，确保命中 5、10 及其两侧
    const nearEndpoint = fc.oneof(
      fc.constant(5),
      fc.constant(10),
      fc.double({ min: 4.5, max: 5.5, noNaN: true }),
      fc.double({ min: 9.5, max: 10.5, noNaN: true })
    );

    fc.assert(
      fc.property(nearEndpoint, (rate) => {
        const decision = applyTurnoverRate(makeRow(rate));
        const expected = rate >= 5 && rate <= 10;
        expect(decision.keep).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});
