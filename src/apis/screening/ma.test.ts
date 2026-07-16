// ma.ts 单元测试：覆盖 sma 的边界情形与 isRising 的判定逻辑
// 需求 7.1（SMA 计算与数据不足返回 null）、需求 7.2（均线向上严格大于判定）

import { describe, expect, test } from "bun:test";
import { sma, isRising } from "./ma";

describe("sma", () => {
  test("数据不足（endIndex + 1 < period）返回 null", () => {
    // 只有 3 个元素可用（索引 0..2），无法计算 period=5 的均值
    expect(sma([1, 2, 3, 4, 5], 5, 2)).toBeNull();
    // 恰好差一个：period=3、endIndex=1，窗口需要索引 -1..1，不足
    expect(sma([10, 20, 30], 3, 1)).toBeNull();
  });

  test("窗口末端越界（endIndex >= closes.length）返回 null", () => {
    expect(sma([1, 2, 3], 2, 3)).toBeNull();
    expect(sma([1, 2, 3], 1, 5)).toBeNull();
  });

  test("空数组返回 null", () => {
    expect(sma([], 1, 0)).toBeNull();
  });

  test("窗口边界：恰好满足 period 个数据时正常计算", () => {
    // period=3、endIndex=2，窗口为索引 0..2 => (1+2+3)/3 = 2
    expect(sma([1, 2, 3], 3, 2)).toBe(2);
  });

  test("正常窗口计算：取末端往前 period 个收盘价的算术平均", () => {
    const closes = [2, 4, 6, 8, 10];
    // period=3、endIndex=4，窗口索引 2..4 => (6+8+10)/3 = 8
    expect(sma(closes, 3, 4)).toBe(8);
    // period=2、endIndex=1，窗口索引 0..1 => (2+4)/2 = 3
    expect(sma(closes, 2, 1)).toBe(3);
  });

  test("period=1 时返回该单点收盘价", () => {
    expect(sma([5, 7, 9], 1, 0)).toBe(5);
    expect(sma([5, 7, 9], 1, 2)).toBe(9);
  });
});

describe("isRising", () => {
  test("当日严格大于前一日判为向上", () => {
    expect(isRising(2, 1)).toBe(true);
  });

  test("两值相等判为不向上", () => {
    expect(isRising(1, 1)).toBe(false);
  });

  test("当日小于前一日判为不向上", () => {
    expect(isRising(1, 2)).toBe(false);
  });

  test("任一值为 null 判为不向上", () => {
    expect(isRising(null, 1)).toBe(false);
    expect(isRising(1, null)).toBe(false);
    expect(isRising(null, null)).toBe(false);
  });
});
