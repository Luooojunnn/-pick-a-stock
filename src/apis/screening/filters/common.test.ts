// common.ts 脚手架冒烟测试
// 覆盖 isValidNumber / inClosedRange / recordExclusion 的典型输入行为
// 对应需求 10.1

import { describe, expect, test } from "bun:test";
import { isValidNumber, inClosedRange, recordExclusion } from "./common";
import type { ExclusionRecord } from "../types";

describe("isValidNumber", () => {
  test("对有限的 number 返回 true", () => {
    expect(isValidNumber(0)).toBe(true);
    expect(isValidNumber(3.5)).toBe(true);
    expect(isValidNumber(-42)).toBe(true);
  });

  test("对 null / undefined / NaN 返回 false", () => {
    expect(isValidNumber(null)).toBe(false);
    expect(isValidNumber(undefined)).toBe(false);
    expect(isValidNumber(NaN)).toBe(false);
  });

  test("对 Infinity 返回 false", () => {
    expect(isValidNumber(Infinity)).toBe(false);
    expect(isValidNumber(-Infinity)).toBe(false);
  });

  test("对字符串（含数字字符串与空串）返回 false", () => {
    expect(isValidNumber("1")).toBe(false);
    expect(isValidNumber("")).toBe(false);
    expect(isValidNumber("abc")).toBe(false);
  });
});

describe("inClosedRange", () => {
  test("闭区间包含端点", () => {
    expect(inClosedRange(0, 0, 10)).toBe(true);
    expect(inClosedRange(10, 0, 10)).toBe(true);
  });

  test("区间内的值返回 true", () => {
    expect(inClosedRange(5, 0, 10)).toBe(true);
  });

  test("区间外的值返回 false", () => {
    expect(inClosedRange(-1, 0, 10)).toBe(false);
    expect(inClosedRange(11, 0, 10)).toBe(false);
  });

  test("无效值一律返回 false", () => {
    expect(inClosedRange(null, 0, 10)).toBe(false);
    expect(inClosedRange(undefined, 0, 10)).toBe(false);
    expect(inClosedRange(NaN, 0, 10)).toBe(false);
    expect(inClosedRange("5", 0, 10)).toBe(false);
  });
});

describe("recordExclusion", () => {
  test("正常写入一条排除记录", () => {
    const records: ExclusionRecord[] = [];
    recordExclusion(records, "600000.SH", "priceFilter", "价格超出区间");
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      ts_code: "600000.SH",
      filter: "priceFilter",
      reason: "价格超出区间",
    });
  });
});
