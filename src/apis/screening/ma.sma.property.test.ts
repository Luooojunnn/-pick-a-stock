// Feature: daily-stock-screening, Property 10: 移动平均线计算正确性
// Validates: Requirements 7.1
//
// 生成随机 close 序列、随机窗口 period 与窗口末端 endIndex，
// 对照朴素算术平均模型验证 sma 的返回值；同时覆盖数据不足返回 null 的情形。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { sma } from "./ma";

// 有限浮点收盘价生成器：排除 NaN 与无穷，避免浮点求和产生非预期结果
const finiteClose = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });

// 朴素参考模型：与被测函数采用相同的求和顺序，
// 保证在数据充足时逐项相加得到完全一致的浮点结果。
function naiveSma(closes: number[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period || endIndex >= closes.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += closes[i]!;
  return sum / period;
}

describe("Property 10: 移动平均线计算正确性", () => {
  // 主属性：对任意序列、period、endIndex，sma 结果与朴素模型完全一致
  test("sma 与朴素算术平均模型一致（含数据不足返回 null）", () => {
    fc.assert(
      fc.property(
        // 允许空数组，覆盖越界与数据不足分支
        fc.array(finiteClose, { minLength: 0, maxLength: 30 }),
        // period 至少为 1
        fc.integer({ min: 1, max: 35 }),
        // endIndex 可能越界（负数由下方 map 排除，保持索引语义为 >= 0）
        fc.integer({ min: 0, max: 40 }),
        (closes, period, endIndex) => {
          const actual = sma(closes, period, endIndex);
          const expected = naiveSma(closes, period, endIndex);
          expect(actual).toBe(expected);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 定向属性：构造保证数据充足的窗口，断言必返回非 null 且等于窗口算术平均
  test("数据充足时返回窗口内 period 个收盘价的算术平均", () => {
    fc.assert(
      fc.property(
        fc.array(finiteClose, { minLength: 1, maxLength: 30 }),
        fc.nat(),
        fc.nat(),
        (closes, endSeed, periodSeed) => {
          // endIndex 落在有效范围 [0, length-1]
          const endIndex = endSeed % closes.length;
          // period 落在有效范围 [1, endIndex+1]，保证数据充足
          const period = (periodSeed % (endIndex + 1)) + 1;

          const actual = sma(closes, period, endIndex);
          expect(actual).not.toBeNull();
          expect(actual).toBe(naiveSma(closes, period, endIndex));
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 定向属性：数据不足（窗口元素不够或末端越界）时必返回 null
  test("数据不足或末端越界时返回 null", () => {
    fc.assert(
      fc.property(
        fc.array(finiteClose, { minLength: 0, maxLength: 20 }),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 0, max: 25 }),
        (closes, period, endIndex) => {
          if (endIndex + 1 < period || endIndex >= closes.length) {
            expect(sma(closes, period, endIndex)).toBeNull();
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
