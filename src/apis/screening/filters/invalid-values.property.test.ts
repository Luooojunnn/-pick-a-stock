// Feature: daily-stock-screening, Property 7: 无效字段值一律排除并记录
// Validates: Requirements 2.4, 3.4, 4.4, 5.4
//
// 属性：向四个截面 filter（涨幅 pct_chg、量比 volume_ratio、换手率 turnover_rate、
// 流通市值 circ_mv）注入无效值集合 {null, undefined, NaN, "", 非数值字符串}，
// 无论落在哪个字段，filter 均应返回 keep:false 且携带 reason；
// 并且配合 recordExclusion 能将排除原因写入 ExclusionRecord 数组。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyPctChg } from "./pct-chg";
import { applyVolumeRatio } from "./volume-ratio";
import { applyTurnoverRate } from "./turnover-rate";
import { applyCircMv } from "./circ-mv";
import { recordExclusion } from "./common";
import type { DailyRow, DailyBasicRow, ExclusionRecord } from "../types";

/**
 * 无效值集合生成器：覆盖 null、undefined、NaN、空字符串、非数值字符串。
 * 这些值一旦出现在被判定字段上，filter 必须一律排除（需求 2.4/3.4/4.4/5.4）。
 */
const invalidValueArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(""),
  // 非数值字符串（排除偶然的纯数字串，确保是真正的非数值）
  fc.string().filter((s) => s.trim() === "" || Number.isNaN(Number(s)))
);

/** 构造一条合法基线 daily 行，随后由测试将无效值注入指定字段 */
function makeDailyRow(): DailyRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    close: 10,
    pct_chg: 4, // 合法基线值（落在 [3,5]）
    vol: 10000,
  };
}

/** 构造一条合法基线 daily_basic 行，随后由测试将无效值注入指定字段 */
function makeDailyBasicRow(): DailyBasicRow {
  return {
    ts_code: "600000.SH",
    trade_date: "20240101",
    volume_ratio: 1.5, // 合法基线值（≥1）
    turnover_rate: 6, // 合法基线值（[5,10]）
    circ_mv: 1000000, // 合法基线值（[500000,2000000]）
  };
}

describe("Property 7：无效字段值一律排除并记录", () => {
  // 涨幅 pct_chg 注入无效值 → 排除并携带 reason（需求 2.4）
  test("applyPctChg：pct_chg 无效值一律排除且带 reason", () => {
    fc.assert(
      fc.property(invalidValueArb, (bad) => {
        const row = { ...makeDailyRow(), pct_chg: bad } as unknown as DailyRow;
        const decision = applyPctChg(row);
        expect(decision.keep).toBe(false);
        if (!decision.keep) {
          expect(typeof decision.reason).toBe("string");
          expect(decision.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // 量比 volume_ratio 注入无效值 → 排除并携带 reason（需求 3.4）
  test("applyVolumeRatio：volume_ratio 无效值一律排除且带 reason", () => {
    fc.assert(
      fc.property(invalidValueArb, (bad) => {
        const row = {
          ...makeDailyBasicRow(),
          volume_ratio: bad,
        } as unknown as DailyBasicRow;
        const decision = applyVolumeRatio(row);
        expect(decision.keep).toBe(false);
        if (!decision.keep) {
          expect(typeof decision.reason).toBe("string");
          expect(decision.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // 换手率 turnover_rate 注入无效值 → 排除并携带 reason（需求 4.4）
  test("applyTurnoverRate：turnover_rate 无效值一律排除且带 reason", () => {
    fc.assert(
      fc.property(invalidValueArb, (bad) => {
        const row = {
          ...makeDailyBasicRow(),
          turnover_rate: bad,
        } as unknown as DailyBasicRow;
        const decision = applyTurnoverRate(row);
        expect(decision.keep).toBe(false);
        if (!decision.keep) {
          expect(typeof decision.reason).toBe("string");
          expect(decision.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // 流通市值 circ_mv 注入无效值 → 排除并携带 reason（需求 5.4）
  test("applyCircMv：circ_mv 无效值一律排除且带 reason", () => {
    fc.assert(
      fc.property(invalidValueArb, (bad) => {
        const row = {
          ...makeDailyBasicRow(),
          circ_mv: bad,
        } as unknown as DailyBasicRow;
        const decision = applyCircMv(row);
        expect(decision.keep).toBe(false);
        if (!decision.keep) {
          expect(typeof decision.reason).toBe("string");
          expect(decision.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // 排除决策可配合 recordExclusion 生成排除记录（需求 2.4/3.4/4.4/5.4）
  test("四个 filter 的排除原因均可写入 ExclusionRecord 数组", () => {
    fc.assert(
      fc.property(invalidValueArb, (bad) => {
        const records: ExclusionRecord[] = [];

        const cases: Array<{ filter: string; decision: ReturnType<typeof applyPctChg> }> = [
          {
            filter: "pct_chg",
            decision: applyPctChg({ ...makeDailyRow(), pct_chg: bad } as unknown as DailyRow),
          },
          {
            filter: "volume_ratio",
            decision: applyVolumeRatio({
              ...makeDailyBasicRow(),
              volume_ratio: bad,
            } as unknown as DailyBasicRow),
          },
          {
            filter: "turnover_rate",
            decision: applyTurnoverRate({
              ...makeDailyBasicRow(),
              turnover_rate: bad,
            } as unknown as DailyBasicRow),
          },
          {
            filter: "circ_mv",
            decision: applyCircMv({
              ...makeDailyBasicRow(),
              circ_mv: bad,
            } as unknown as DailyBasicRow),
          },
        ];

        for (const { filter, decision } of cases) {
          expect(decision.keep).toBe(false);
          if (!decision.keep) {
            recordExclusion(records, "600000.SH", filter, decision.reason);
          }
        }

        // 四个 filter 均排除，应生成 4 条排除记录
        expect(records.length).toBe(4);
        for (const rec of records) {
          expect(rec.ts_code).toBe("600000.SH");
          expect(rec.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });
});
