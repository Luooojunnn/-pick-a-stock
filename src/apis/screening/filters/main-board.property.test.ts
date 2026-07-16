// Feature: daily-stock-screening, Property 1: 主板筛选与排除优先级
// Validates: Requirements 1.2, 1.3, 1.4
//
// 对任意股票集合（market 与 ts_code 前缀随机，含冲突边界），断言主板筛选后：
// 1) 每只保留股票的 market 严格等于"主板"，且代码前缀属于白名单 {600,601,603,605,000,001,002}；
// 2) 任何代码前缀属于创业板(300/301)、科创板(688/689)、北交所(8/4) 的股票一定不在结果中，
//    即排除规则相对保留规则具有绝对优先级（同时命中保留与排除条件时以排除为准）。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { StockBasicRow } from "../types";
import { isMainBoard } from "./main-board";

// 沪深主板代码前缀白名单（需求 1.3）
const WHITELIST_PREFIXES = ["600", "601", "603", "605", "000", "001", "002"];
// 排除板块前缀（需求 1.4）：创业板 300/301、科创板 688/689、北交所 8/4 开头
const EXCLUDED_PREFIXES = ["300", "301", "688", "689", "8", "4"];
// 既不在白名单、也不属于排除板块的其他前缀（应因不满足白名单而被排除）
const OTHER_PREFIXES = ["200", "900", "730", "500", "159", "510"];

// 交易所后缀
const EXCHANGE_SUFFIXES = [".SH", ".SZ", ".BJ"];

// 市场字段候选（含"主板"及各非主板板块与噪声值）
const MARKETS = ["主板", "创业板", "科创板", "北交所", "CDR", "", "未知"];

/** 判断代码前缀是否命中排除板块（与实现口径一致：单字符前缀用 startsWith） */
function hasExcludedPrefix(code: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => code.startsWith(p));
}

/** 判断代码前缀是否属于白名单 */
function hasWhitelistPrefix(code: string): boolean {
  return WHITELIST_PREFIXES.some((p) => code.startsWith(p));
}

// 由某个前缀生成 6 位数字代码：前缀 + 随机补齐至 6 位
function codeFromPrefix(prefix: string): fc.Arbitrary<string> {
  const remaining = 6 - prefix.length;
  return fc
    .array(fc.integer({ min: 0, max: 9 }), {
      minLength: remaining,
      maxLength: remaining,
    })
    .map((digits) => prefix + digits.join(""));
}

// 数字代码生成器：从白名单、排除、其他三类前缀中随机取一类再补齐，覆盖冲突边界
const numericCode: fc.Arbitrary<string> = fc
  .constantFrom(...WHITELIST_PREFIXES, ...EXCLUDED_PREFIXES, ...OTHER_PREFIXES)
  .chain((prefix) => codeFromPrefix(prefix));

// 完整 ts_code（数字代码 + 交易所后缀）
const tsCode: fc.Arbitrary<string> = fc
  .tuple(numericCode, fc.constantFrom(...EXCHANGE_SUFFIXES))
  .map(([code, suffix]) => code + suffix);

// 随机 StockBasicRow：market 与 ts_code 独立随机，制造保留/排除的各种冲突组合
const stockRow: fc.Arbitrary<StockBasicRow> = fc.record({
  ts_code: tsCode,
  name: fc.string({ minLength: 0, maxLength: 6 }),
  market: fc.constantFrom(...MARKETS),
});

describe("Property 1: 主板筛选与排除优先级", () => {
  test("保留股票满足白名单且 market=主板；排除板块前缀绝不保留（排除优先）", () => {
    fc.assert(
      fc.property(fc.array(stockRow, { minLength: 0, maxLength: 50 }), (stocks) => {
        const kept = stocks.filter(isMainBoard);

        for (const stock of kept) {
          const code = stock.ts_code.split(".")[0] ?? "";

          // 保留股票 market 必须严格等于"主板"（需求 1.2）
          expect(stock.market).toBe("主板");

          // 保留股票代码前缀必须属于白名单（需求 1.3）
          expect(hasWhitelistPrefix(code)).toBe(true);

          // 排除优先：保留股票绝不命中排除板块前缀（需求 1.4）
          expect(hasExcludedPrefix(code)).toBe(false);
        }

        // 任何命中排除板块前缀的股票一定不在结果中（排除的绝对优先级）
        for (const stock of stocks) {
          const code = stock.ts_code.split(".")[0] ?? "";
          if (hasExcludedPrefix(code)) {
            expect(kept).not.toContain(stock);
          }
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
