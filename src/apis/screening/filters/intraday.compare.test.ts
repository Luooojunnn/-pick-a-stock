// intraday.ts 纯比较函数单元测试（需求 8.2/8.3/8.4/8.5/8.6）
// 覆盖：
// - toPctChg 涨跌幅换算（含 open<=0 / 无效值返回 null）
// - computeOutperformRatio 仅比较双方均有数据的对齐时间点、占比计算正确
// - decideIntraday 占比阈值判定，以及有效对齐点为 0 时不排除（需求 8.6）

import { describe, expect, test } from "bun:test";
import {
  computeOutperformRatio,
  decideIntraday,
  toPctChg,
  type MinuteBar,
  INTRADAY_OUTPERFORM_THRESHOLD,
} from "./intraday";

describe("toPctChg 涨跌幅换算（需求 8.2）", () => {
  test("正常换算：(price-open)/open*100", () => {
    // 开盘 10，价格 11 → (11-10)/10*100 = 10
    expect(toPctChg(10, 11)).toBeCloseTo(10, 10);
    // 开盘 10，价格 9 → -10
    expect(toPctChg(10, 9)).toBeCloseTo(-10, 10);
    // 价格等于开盘 → 0
    expect(toPctChg(10, 10)).toBe(0);
  });

  test("open <= 0 无法作为基准 → 返回 null", () => {
    expect(toPctChg(0, 10)).toBeNull();
    expect(toPctChg(-5, 10)).toBeNull();
  });

  test("无效值（null/undefined/NaN/非数值）→ 返回 null", () => {
    expect(toPctChg(null, 10)).toBeNull();
    expect(toPctChg(undefined, 10)).toBeNull();
    expect(toPctChg(NaN, 10)).toBeNull();
    expect(toPctChg("10", 10)).toBeNull();
    expect(toPctChg(10, null)).toBeNull();
    expect(toPctChg(10, undefined)).toBeNull();
    expect(toPctChg(10, NaN)).toBeNull();
    expect(toPctChg(10, "11")).toBeNull();
  });
});

describe("computeOutperformRatio 对齐与占比计算（需求 8.2/8.3）", () => {
  test("双方全部对齐：个股全部强于大盘 → 占比 1", () => {
    const stockBars: MinuteBar[] = [
      { time: "0930", price: 11 }, // 个股 +10%
      { time: "0931", price: 12 }, // 个股 +20%
    ];
    const indexBars: MinuteBar[] = [
      { time: "0930", price: 101 }, // 大盘 +1%
      { time: "0931", price: 102 }, // 大盘 +2%
    ];
    const r = computeOutperformRatio(10, stockBars, 100, indexBars);
    expect(r.validPoints).toBe(2);
    expect(r.outperformPoints).toBe(2);
    expect(r.ratio).toBe(1);
  });

  test("部分强于大盘 → 占比正确（含相等按 >= 计强势）", () => {
    // 个股与大盘开盘价均取 100，便于产生精确的涨跌幅相等边界
    const stockBars: MinuteBar[] = [
      { time: "0930", price: 110 }, // 个股 +10% > 大盘 +1% → 强势
      { time: "0931", price: 101 }, // 个股 +1% == 大盘 +1% → 强势（>=）
      { time: "0932", price: 99 }, // 个股 -1% < 大盘 +1% → 非强势
    ];
    const indexBars: MinuteBar[] = [
      { time: "0930", price: 101 }, // 大盘 +1%
      { time: "0931", price: 101 }, // 大盘 +1%
      { time: "0932", price: 101 }, // 大盘 +1%
    ];
    const r = computeOutperformRatio(100, stockBars, 100, indexBars);
    expect(r.validPoints).toBe(3);
    expect(r.outperformPoints).toBe(2);
    expect(r.ratio).toBeCloseTo(2 / 3, 10);
  });

  test("仅比较双方均有数据的对齐点：时间不匹配的点不计入", () => {
    const stockBars: MinuteBar[] = [
      { time: "0930", price: 11 }, // 有对齐
      { time: "0931", price: 12 }, // 大盘无此时刻 → 不计入
      { time: "0933", price: 13 }, // 大盘无此时刻 → 不计入
    ];
    const indexBars: MinuteBar[] = [
      { time: "0930", price: 101 }, // 有对齐
      { time: "0932", price: 102 }, // 个股无此时刻 → 不计入
    ];
    const r = computeOutperformRatio(10, stockBars, 100, indexBars);
    // 仅 0930 双方均有数据
    expect(r.validPoints).toBe(1);
    expect(r.outperformPoints).toBe(1);
    expect(r.ratio).toBe(1);
  });

  test("个股某点无效数据（价格非法）不计入有效对齐点", () => {
    const stockBars: MinuteBar[] = [
      { time: "0930", price: 11 }, // 有效
      { time: "0931", price: NaN as unknown as number }, // 个股无效 → 不计入
    ];
    const indexBars: MinuteBar[] = [
      { time: "0930", price: 101 },
      { time: "0931", price: 102 },
    ];
    const r = computeOutperformRatio(10, stockBars, 100, indexBars);
    expect(r.validPoints).toBe(1);
    expect(r.outperformPoints).toBe(1);
  });

  test("大盘开盘价无效（open<=0）→ 所有对齐点均无有效大盘数据，validPoints 为 0", () => {
    const stockBars: MinuteBar[] = [
      { time: "0930", price: 11 },
      { time: "0931", price: 12 },
    ];
    const indexBars: MinuteBar[] = [
      { time: "0930", price: 101 },
      { time: "0931", price: 102 },
    ];
    const r = computeOutperformRatio(10, stockBars, 0, indexBars);
    expect(r.validPoints).toBe(0);
    expect(r.outperformPoints).toBe(0);
    expect(r.ratio).toBe(0);
  });

  test("无任何对齐时间点 → validPoints 为 0、ratio 为 0", () => {
    const stockBars: MinuteBar[] = [{ time: "0930", price: 11 }];
    const indexBars: MinuteBar[] = [{ time: "1000", price: 101 }];
    const r = computeOutperformRatio(10, stockBars, 100, indexBars);
    expect(r.validPoints).toBe(0);
    expect(r.ratio).toBe(0);
  });
});

describe("decideIntraday 占比阈值判定（需求 8.4/8.5/8.6）", () => {
  test("有效对齐点为 0 → 不排除（keep:true，需求 8.6）", () => {
    const decision = decideIntraday({
      validPoints: 0,
      outperformPoints: 0,
      ratio: 0,
    });
    expect(decision.keep).toBe(true);
  });

  test("占比 == 阈值 0.5 → 保留（需求 8.4，含端点）", () => {
    const decision = decideIntraday({
      validPoints: 2,
      outperformPoints: 1,
      ratio: INTRADAY_OUTPERFORM_THRESHOLD,
    });
    expect(decision.keep).toBe(true);
  });

  test("占比 > 阈值 → 保留（需求 8.4）", () => {
    const decision = decideIntraday({
      validPoints: 4,
      outperformPoints: 3,
      ratio: 0.75,
    });
    expect(decision.keep).toBe(true);
  });

  test("占比 < 阈值 → 排除且携带原因（需求 8.5）", () => {
    const decision = decideIntraday({
      validPoints: 4,
      outperformPoints: 1,
      ratio: 0.25,
    });
    expect(decision.keep).toBe(false);
    if (decision.keep === false) {
      expect(decision.reason).toContain("低于阈值");
    }
  });
});
