// Feature: daily-stock-screening, Property 12: 均线趋势分级判定、互斥与数据长度分支
// Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7
//
// 对任意升序历史收盘价序列（末位为基准日），构造多头/非多头形态与关键长度
// （10、11、60、61 等）序列，断言 classifyMaTrend 的行为满足：
// - 长度 < 11 → keep:false（数据不足，需求 7.7）
// - MA5 或 MA10 不向上 → keep:false（需求 7.5）
// - 长度 >= 61 且多头排列（MA5>MA10>MA20>MA60）且四线均向上 → grade="理想条件"（需求 7.3）
// - 长度 < 61 时结果绝不为"理想条件"（需求 7.6）
// - 满足 MA5/MA10 向上但非理想 → grade="放宽条件"（需求 7.4、7.6）
// - 保留股绝不同时具"理想条件"与"放宽条件"两个标注（互斥性）
//
// 期望值以参考模型方式、复用 ma 的 sma/isRising 独立复算后对照。

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { classifyMaTrend } from "./ma-trend";
import { sma, isRising } from "../ma";
import type { GradeLabel } from "../types";

// 收盘价：有限正数，覆盖常见量级
const closeVal = fc.double({
  noNaN: true,
  noDefaultInfinity: true,
  min: 1,
  max: 1000,
});

// 关键长度（含 10/11/60/61 边界）与随机长度混合
const lengthGen = fc.oneof(
  fc.constantFrom(0, 1, 5, 9, 10, 11, 12, 20, 59, 60, 61, 62, 90, 120),
  fc.integer({ min: 0, max: 130 })
);

// 序列形态：递增（多头倾向）、递减、常量、随机
const shapeGen = fc.constantFrom("asc", "desc", "const", "random");

// 依据形态整形出定长收盘价序列
function shapeArr(arr: number[], shape: string): number[] {
  if (arr.length === 0) return arr;
  if (shape === "asc") {
    // 严格递增：以正的原始值作为累加增量，避免相等
    let acc = 0;
    return arr.map((v) => (acc += v));
  }
  if (shape === "desc") {
    // 严格递减：先构造严格递增再反转
    let acc = 0;
    const inc = arr.map((v) => (acc += v));
    return inc.reverse();
  }
  if (shape === "const") {
    // 全部相等
    return arr.map(() => arr[0]!);
  }
  return arr; // random
}

// 组合生成定长且带形态的收盘价序列
const closesGen = fc
  .tuple(lengthGen, shapeGen)
  .chain(([len, shape]) =>
    fc
      .array(closeVal, { minLength: len, maxLength: len })
      .map((arr) => shapeArr(arr, shape))
  );

// 严格递增序列生成器（指定长度）
const strictIncreasingOfLength = (lenGen: fc.Arbitrary<number>) =>
  lenGen.chain((len) =>
    fc
      .array(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: 0.001, max: 100 }),
        { minLength: len, maxLength: len }
      )
      .map((incs) => {
        let acc = 0;
        return incs.map((i) => (acc += i));
      })
  );

describe("Property 12: 均线趋势分级判定、互斥与数据长度分支", () => {
  // 主属性：以 sma/isRising 复算期望，全面对照分级、互斥与长度分支
  test("分级、互斥与长度分支均符合参考模型", () => {
    fc.assert(
      fc.property(closesGen, (closes) => {
        const n = closes.length;
        const decision = classifyMaTrend(closes);

        // 长度 < 11 → 排除（需求 7.7）
        if (n < 11) {
          expect(decision.keep).toBe(false);
          return true;
        }

        const end = n - 1;
        const prev = n - 2;
        const rising = (p: number) =>
          isRising(sma(closes, p, end), sma(closes, p, prev));

        const ma5Up = rising(5);
        const ma10Up = rising(10);

        // MA5 或 MA10 不向上 → 排除（需求 7.5）
        if (!ma5Up || !ma10Up) {
          expect(decision.keep).toBe(false);
          return true;
        }

        // 此时应保留
        expect(decision.keep).toBe(true);

        // 计算理想条件（仅长度 >= 61 时才可能成立，需求 7.6）
        let ideal = false;
        if (n >= 61) {
          const ma5 = sma(closes, 5, end)!;
          const ma10 = sma(closes, 10, end)!;
          const ma20 = sma(closes, 20, end)!;
          const ma60 = sma(closes, 60, end)!;
          const bullishOrder = ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
          const allUp = rising(20) && rising(60);
          ideal = bullishOrder && allUp;
        }

        if (decision.keep) {
          // 分级取值必属于合法集合（互斥：单一字段二选一）
          const grade: GradeLabel | undefined = decision.grade;
          expect(["理想条件", "放宽条件"]).toContain(grade);
          // 与参考模型一致（需求 7.3 / 7.4）
          expect(grade).toBe(ideal ? "理想条件" : "放宽条件");
          // 长度 < 61 时绝不为"理想条件"（需求 7.6）
          if (n < 61) {
            expect(grade).not.toBe("理想条件");
          }
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });

  // 长度 < 11 一律排除（需求 7.7）
  test("长度小于 11 一律排除且标数据不足", () => {
    fc.assert(
      fc.property(
        fc.array(closeVal, { minLength: 0, maxLength: 10 }),
        (closes) => {
          const decision = classifyMaTrend(closes);
          expect(decision.keep).toBe(false);
          if (!decision.keep) {
            expect(decision.reason).toContain("数据不足");
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 严格递增且长度 >= 61 → 多头排列且四线向上 → 理想条件（需求 7.3）
  test("长度大于等于 61 的多头（严格递增）标注为理想条件", () => {
    fc.assert(
      fc.property(
        strictIncreasingOfLength(fc.integer({ min: 61, max: 130 })),
        (closes) => {
          const decision = classifyMaTrend(closes);
          expect(decision.keep).toBe(true);
          if (decision.keep) {
            expect(decision.grade).toBe("理想条件");
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 长度在 [11,60] 且 MA5/MA10 向上（严格递增）→ 放宽条件，且绝不为理想（需求 7.4、7.6）
  test("长度小于 61 的向上序列标注为放宽条件且绝不为理想", () => {
    fc.assert(
      fc.property(
        strictIncreasingOfLength(fc.integer({ min: 11, max: 60 })),
        (closes) => {
          const decision = classifyMaTrend(closes);
          expect(decision.keep).toBe(true);
          if (decision.keep) {
            expect(decision.grade).toBe("放宽条件");
            expect(decision.grade).not.toBe("理想条件");
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // 严格递减（长度 >= 11）→ MA5/MA10 不向上 → 排除（需求 7.5）
  test("严格递减序列因均线不向上而排除", () => {
    fc.assert(
      fc.property(
        strictIncreasingOfLength(fc.integer({ min: 11, max: 130 })).map((a) =>
          a.slice().reverse()
        ),
        (closes) => {
          const decision = classifyMaTrend(closes);
          expect(decision.keep).toBe(false);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
