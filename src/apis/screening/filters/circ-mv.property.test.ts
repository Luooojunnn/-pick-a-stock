// Feature: daily-stock-screening, Property 6: 流通市值区间筛选（含端点 500000、2000000）
// Validates: Requirements 5.2, 5.3
//
// 属性：对任意有效数值 circ_mv（万元），applyCircMv 保留该股当且仅当
// 500000 ≤ circ_mv ≤ 2000000（含两端端点）；区间外一律排除。
// 生成器专门覆盖两端点 500000、2000000 及区间内外。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyCircMv } from "./circ-mv";
import type { DailyBasicRow } from "../types";

/** 流通市值区间下界（含端点） */
const CIRC_MV_MIN = 500000;
/** 流通市值区间上界（含端点） */
const CIRC_MV_MAX = 2000000;

/** 用给定 circ_mv 构造一条合法的 daily_basic 行 */
function makeRow(circ_mv: number): DailyBasicRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    volume_ratio: 1.5,
    turnover_rate: 6,
    circ_mv,
  };
}

describe("applyCircMv 属性测试", () => {
  // Property 6：随机有效数值覆盖区间内外，断言 keep 当且仅当落在闭区间内
  test("keep 为真当且仅当 500000<=circ_mv<=2000000", () => {
    // 生成器覆盖端点、区间内、区间外（下溢/上溢），并混入两端点常量
    const circMvArb = fc.oneof(
      // 广域随机有效数值（覆盖负数、0、极大值）
      fc.double({ min: -1e7, max: 1e7, noNaN: true }),
      // 端点邻域，密集覆盖边界两侧
      fc.double({ min: CIRC_MV_MIN - 10, max: CIRC_MV_MIN + 10, noNaN: true }),
      fc.double({ min: CIRC_MV_MAX - 10, max: CIRC_MV_MAX + 10, noNaN: true }),
      // 明确包含两端点常量
      fc.constant(CIRC_MV_MIN),
      fc.constant(CIRC_MV_MAX)
    );

    fc.assert(
      fc.property(circMvArb, (circ_mv) => {
        const decision = applyCircMv(makeRow(circ_mv));
        const expected = circ_mv >= CIRC_MV_MIN && circ_mv <= CIRC_MV_MAX;
        expect(decision.keep).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  // Property 6：两端点必然保留（含端点语义专项覆盖）
  test("端点 500000 与 2000000 均保留", () => {
    expect(applyCircMv(makeRow(CIRC_MV_MIN)).keep).toBe(true);
    expect(applyCircMv(makeRow(CIRC_MV_MAX)).keep).toBe(true);
  });
});
