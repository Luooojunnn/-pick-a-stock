// Feature: daily-stock-screening, Property 4: 量比阈值筛选（含端点 1）
// Validates: Requirements 3.2, 3.3
//
// 属性：对任意有效数值 volume_ratio，量比筛选保留该股当且仅当 volume_ratio >= 1（含端点 1）；
// 小于 1 一律排除。生成随机浮点并专门覆盖端点 1。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DailyBasicRow } from "../types";
import { applyVolumeRatio } from "./volume-ratio";

/** 构造一个仅关注 volume_ratio 的 daily_basic 行（其余字段填占位有效值） */
function makeBasic(volumeRatio: number): DailyBasicRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    volume_ratio: volumeRatio,
    turnover_rate: 6,
    circ_mv: 1000000,
  };
}

describe("applyVolumeRatio 属性测试", () => {
  // Property 4：随机有效浮点验证 keep 为真当且仅当 volume_ratio >= 1
  test("keep 为真当且仅当 volume_ratio >= 1", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (vr) => {
        const decision = applyVolumeRatio(makeBasic(vr));
        expect(decision.keep).toBe(vr >= 1);
      }),
      { numRuns: 100 }
    );
  });

  // Property 4：端点 1 专项覆盖——恰好等于 1 时必须保留
  test("端点：volume_ratio === 1 时保留", () => {
    const decision = applyVolumeRatio(makeBasic(1));
    expect(decision.keep).toBe(true);
  });

  // Property 4：端点邻域覆盖——生成靠近 1 的随机值，验证边界两侧判定正确
  test("端点邻域：接近 1 的随机值判定正确", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.9, max: 1.1, noNaN: true, noDefaultInfinity: true }),
        (vr) => {
          const decision = applyVolumeRatio(makeBasic(vr));
          expect(decision.keep).toBe(vr >= 1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
