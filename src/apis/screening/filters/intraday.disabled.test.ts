// intraday.ts 占位透传单元测试（需求 8.6）
// 断言：分钟权限未开通（INTRADAY_ENABLED=false）时，applyIntradayFilter
// 原样透传候选集、不排除任何股票，且不触发任何分钟接口（stk_mins/idx_mins）调用。

import { describe, expect, test } from "bun:test";
import { INTRADAY_ENABLED, applyIntradayFilter } from "./intraday";
import type { ScreeningContext } from "../types";

// 构造筛选上下文；intradayEnabled 可任意取值，禁用开关下均应透传。
function makeCtx(intradayEnabled: boolean): ScreeningContext {
  return { referenceDay: "20240101", intradayEnabled };
}

describe("INTRADAY_ENABLED 默认禁用（需求 8.6）", () => {
  test("开关常量为 false", () => {
    expect(INTRADAY_ENABLED).toBe(false);
  });
});

describe("applyIntradayFilter 占位透传（需求 8.6）", () => {
  test("ctx.intradayEnabled=false 时候选集原样返回、不排除", async () => {
    const candidates = [
      { ts_code: "600000.SH", name: "浦发银行" },
      { ts_code: "000001.SZ", name: "平安银行" },
      { ts_code: "601398.SH", name: "工商银行" },
    ];
    const result = await applyIntradayFilter(candidates, makeCtx(false));

    // 原样透传：返回同一引用、长度与内容完全一致，未排除任何股票。
    expect(result).toBe(candidates);
    expect(result).toEqual(candidates);
    expect(result).toHaveLength(candidates.length);
  });

  test("ctx.intradayEnabled=true 时仍原样透传（受 INTRADAY_ENABLED=false 约束）", async () => {
    const candidates = [
      { ts_code: "600000.SH", name: "浦发银行" },
      { ts_code: "000001.SZ", name: "平安银行" },
    ];
    const result = await applyIntradayFilter(candidates, makeCtx(true));

    // 即便上下文声明启用，全局开关关闭时也不得排除或改变候选集。
    expect(result).toBe(candidates);
    expect(result).toEqual(candidates);
  });

  test("空候选集透传返回空数组", async () => {
    const candidates: Array<{ ts_code: string; name: string }> = [];
    const result = await applyIntradayFilter(candidates, makeCtx(false));

    expect(result).toBe(candidates);
    expect(result).toHaveLength(0);
  });

  test("不依赖任何网络：全程未触发 fetch（需求 8.6 未调用分钟接口）", async () => {
    // 通过替换全局 fetch 为抛错桩，验证禁用时函数不发起任何网络请求。
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    // @ts-expect-error 测试期替换全局 fetch
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error("禁用时不应调用任何分钟接口");
    };

    try {
      const candidates = [{ ts_code: "600000.SH", name: "浦发银行" }];
      const result = await applyIntradayFilter(candidates, makeCtx(true));
      expect(fetchCalled).toBe(false);
      expect(result).toBe(candidates);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
