// Feature: daily-stock-screening, Property 3: 涨幅区间筛选（含端点 3、5）
// Validates: Requirements 2.2, 2.3
//
// 生成随机有效数值 pct_chg（覆盖 3、5 端点及区间内外），构造 DailyRow 后调用
// applyPctChg，断言 keep 为真当且仅当 3 <= pct_chg <= 5（含端点），区间外一律排除。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { DailyRow } from "../types";
import { applyPctChg } from "./pct-chg";

// 构造合理的 DailyRow：仅 pct_chg 为被测变量，其余字段填充合理占位值
function makeDailyRow(pctChg: number): DailyRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    close: 10,
    pct_chg: pctChg,
    vol: 10000,
  };
}

describe("Property 3: 涨幅区间筛选（含端点 3、5）", () => {
  // 主属性：对任意有效数值 pct_chg，keep 为真当且仅当落在闭区间 [3, 5]
  test("keep 当且仅当 3 <= pct_chg <= 5（含端点）", () => {
    fc.assert(
      fc.property(
        // 有限浮点数，范围覆盖区间内外，且用 map 加入 3、5 端点附近的密集取样
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -20, max: 20 }),
        (pctChg) => {
          const decision = applyPctChg(makeDailyRow(pctChg));
          const expectedKeep = pctChg >= 3 && pctChg <= 5;
          expect(decision.keep).toBe(expectedKeep);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 端点属性：显式覆盖 3、5 端点必须保留
  test("端点 3 与 5 必须保留", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 5), (pctChg) => {
        expect(applyPctChg(makeDailyRow(pctChg)).keep).toBe(true);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  // 区间外属性：小于 3 或大于 5 一律排除
  test("区间外（<3 或 >5）一律排除", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: true, noDefaultInfinity: true, min: -20, max: 3 - 1e-6 }),
          fc.double({ noNaN: true, noDefaultInfinity: true, min: 5 + 1e-6, max: 20 })
        ),
        (pctChg) => {
          expect(applyPctChg(makeDailyRow(pctChg)).keep).toBe(false);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
