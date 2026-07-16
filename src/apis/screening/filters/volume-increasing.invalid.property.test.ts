// Feature: daily-stock-screening, Property 9: 成交量数据不足或非法一律排除
// Validates: Requirements 6.5
//
// 属性：对任意最近成交量序列，若不足三条、或其中存在缺失（null/undefined/NaN）或 ≤0 的值，
// 则该股一律被排除（keep:false 且带 reason），并可据此生成一条可查询排除记录；
// 即使记录操作失败，排除仍然发生。
//
// 生成两类输入：
//  (a) 长度 < 3 的数值序列；
//  (b) 长度 >= 3 但含 ≤0 或 NaN/缺失的序列。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ExclusionRecord } from "../types";
import { recordExclusion } from "./common";
import { classifyVolume } from "./volume-increasing";

/** 一个有效的正成交量生成器（严格 > 0 的有限数值） */
const positiveVol = fc.double({
  min: 0.0001,
  max: 1e9,
  noNaN: true,
  noDefaultInfinity: true,
});

/** 非法值生成器：≤0 的数值、NaN、以及缺失（null/undefined） */
const invalidVol = fc.oneof(
  fc.double({ min: -1e9, max: 0, noNaN: true, noDefaultInfinity: true }), // ≤0
  fc.constant(Number.NaN),
  fc.constant(null),
  fc.constant(undefined)
) as fc.Arbitrary<number>;

describe("classifyVolume 数据不足或非法一律排除（Property 9）", () => {
  // (a) 长度 < 3 的数值序列一律排除
  test("长度 < 3 的序列一律排除并携带原因", () => {
    fc.assert(
      fc.property(
        fc.array(positiveVol, { minLength: 0, maxLength: 2 }),
        (recent) => {
          const decision = classifyVolume(recent);
          expect(decision.keep).toBe(false);
          if (!decision.keep) {
            expect(typeof decision.reason).toBe("string");
            expect(decision.reason.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // (b) 长度 >= 3 但含 ≤0 或 NaN/缺失的序列一律排除
  test("长度 >= 3 但含非法值（≤0 / NaN / 缺失）一律排除并携带原因", () => {
    fc.assert(
      fc.property(
        // 构造：一段合法正值 + 至少一个非法值 + 一段合法正值，随后打乱插入位置
        fc
          .record({
            head: fc.array(positiveVol, { minLength: 0, maxLength: 4 }),
            bad: fc.array(invalidVol, { minLength: 1, maxLength: 3 }),
            tail: fc.array(positiveVol, { minLength: 0, maxLength: 4 }),
          })
          .map(({ head, bad, tail }) => [...head, ...bad, ...tail])
          .filter((arr) => arr.length >= 3),
        (recent) => {
          const decision = classifyVolume(recent);
          expect(decision.keep).toBe(false);
          if (!decision.keep) {
            expect(typeof decision.reason).toBe("string");
            expect(decision.reason.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // 排除时可生成一条可查询排除记录（配合 recordExclusion 验证记录生成）
  test("被排除时生成含股票代码与原因的排除记录", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // (a) 长度 < 3
          fc.array(positiveVol, { minLength: 0, maxLength: 2 }),
          // (b) 长度 >= 3 含非法值
          fc
            .record({
              head: fc.array(positiveVol, { minLength: 0, maxLength: 4 }),
              bad: fc.array(invalidVol, { minLength: 1, maxLength: 3 }),
              tail: fc.array(positiveVol, { minLength: 0, maxLength: 4 }),
            })
            .map(({ head, bad, tail }) => [...head, ...bad, ...tail])
            .filter((arr) => arr.length >= 3)
        ),
        fc.string({ minLength: 1, maxLength: 12 }),
        (recent, tsCode) => {
          const records: ExclusionRecord[] = [];
          const decision = classifyVolume(recent);
          expect(decision.keep).toBe(false);
          if (!decision.keep) {
            recordExclusion(records, tsCode, "volume-increasing", decision.reason);
          }
          // 一律排除 → 必然生成一条记录
          expect(records.length).toBe(1);
          expect(records[0].ts_code).toBe(tsCode);
          expect(records[0].filter).toBe("volume-increasing");
          expect(records[0].reason.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
