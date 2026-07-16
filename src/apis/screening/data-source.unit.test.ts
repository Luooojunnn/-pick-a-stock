// data-source.ts 单元测试（mock callTushare）
// 通过 __setCallTushare 注入 mock 隔离网络，验证取数层的三类策略：
// - 超时：单次调用超时抛出 kind='timeout' 的失败错误（需求 10.4）
// - 瞬时失败重试：网络类错误最多重试 3 次，相邻重试间隔 ≥ 1 秒（需求 10.5）
// - 权限错误：命中权限/积分关键字不重试，抛出 kind='permission'（需求 10.6）

import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchWithPolicy,
  __setCallTushare,
  __resetCallTushare,
  RETRY_INTERVAL_MS,
  DEFAULT_MAX_RETRIES,
} from "./data-source";
import { ScreeningError } from "./types";

// 每个用例结束后恢复真实 callTushare，避免用例间相互污染
afterEach(() => {
  __resetCallTushare();
});

describe("fetchWithPolicy 超时策略（需求 10.4）", () => {
  test("单次调用超时应抛出 kind='timeout' 的 ScreeningError 且携带接口名", async () => {
    let callCount = 0;
    // mock 返回一个永不 resolve 的 promise，触发本层的超时逻辑
    __setCallTushare(() => {
      callCount++;
      return new Promise<never[]>(() => {
        /* 永不 resolve */
      });
    });

    // 使用极小超时与 maxRetries=0，避免重试放大测试时长
    const promise = fetchWithPolicy(
      "daily_basic",
      { trade_date: "20240101" },
      "ts_code",
      { timeoutMs: 30, maxRetries: 0 }
    );

    // 断言最终抛出携带失败接口名、kind='timeout' 的 ScreeningError
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ScreeningError);
    const se = caught as ScreeningError;
    expect(se.kind).toBe("timeout");
    expect(se.apiName).toBe("daily_basic");
    // maxRetries=0：仅尝试一次
    expect(callCount).toBe(1);
  });
});

describe("fetchWithPolicy 瞬时失败重试策略（需求 10.5）", () => {
  test(
    "网络类瞬时错误先失败后成功：重试发生、总调用次数 ≤ 1+maxRetries、相邻间隔 ≥ 1 秒",
    async () => {
      const timestamps: number[] = [];
      let callCount = 0;
      const maxRetries = 2; // 控制测试时长：最多 2 次重试

      __setCallTushare(async () => {
        callCount++;
        timestamps.push(Date.now());
        // 前两次抛网络类瞬时错误，第三次成功返回
        if (callCount <= 2) {
          throw new Error("fetch failed: network error");
        }
        return [{ ts_code: "600000.SH" }] as Record<string, unknown>[];
      });

      const rows = await fetchWithPolicy(
        "daily",
        { trade_date: "20240101" },
        "ts_code",
        { timeoutMs: 5_000, maxRetries }
      );

      // 最终成功返回 mock 数据
      expect(rows).toHaveLength(1);
      // 总调用次数 = 首次 + 2 次重试 = 3，且不超过 1 + maxRetries
      expect(callCount).toBe(3);
      expect(callCount).toBeLessThanOrEqual(1 + maxRetries);
      // 相邻调用（即每次重试前的等待）间隔均 ≥ RETRY_INTERVAL_MS
      for (let i = 1; i < timestamps.length; i++) {
        const gap = (timestamps[i] as number) - (timestamps[i - 1] as number);
        // 留少量时钟抖动余量
        expect(gap).toBeGreaterThanOrEqual(RETRY_INTERVAL_MS - 20);
      }
    },
    // bun:test 用例超时：2 次重试各等待 ≥1s，放宽到 10s
    10_000
  );

  test(
    "瞬时错误持续失败：重试耗尽后抛错，总调用次数为 1+maxRetries",
    async () => {
      let callCount = 0;
      const maxRetries = 2;

      __setCallTushare(async () => {
        callCount++;
        // 始终抛出可重试的瞬时错误
        throw new Error("ETIMEDOUT socket hang up");
      });

      let caught: unknown;
      try {
        await fetchWithPolicy("daily", {}, "ts_code", {
          timeoutMs: 5_000,
          maxRetries,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ScreeningError);
      expect((caught as ScreeningError).apiName).toBe("daily");
      // 首次 + maxRetries 次重试
      expect(callCount).toBe(1 + maxRetries);
    },
    10_000
  );

  test("常量约束：默认最多重试 3 次、相邻间隔至少 1 秒", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
    expect(RETRY_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("fetchWithPolicy 权限错误策略（需求 10.6）", () => {
  test("命中『权限』关键字：不重试，抛出 kind='permission' 的 ScreeningError", async () => {
    let callCount = 0;
    __setCallTushare(async () => {
      callCount++;
      throw new Error("抱歉，您没有接口访问权限");
    });

    let caught: unknown;
    try {
      await fetchWithPolicy("daily_basic", {}, "ts_code");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ScreeningError);
    const se = caught as ScreeningError;
    expect(se.kind).toBe("permission");
    expect(se.apiName).toBe("daily_basic");
    // 权限错误不重试，mock 仅被调用一次
    expect(callCount).toBe(1);
  });

  test("命中『积分』关键字：同样不重试并抛出 permission 错误", async () => {
    let callCount = 0;
    __setCallTushare(async () => {
      callCount++;
      throw new Error("积分不足，无法访问该接口");
    });

    let caught: unknown;
    try {
      await fetchWithPolicy("daily", {}, "ts_code", { maxRetries: 3 });
    } catch (err) {
      caught = err;
    }

    expect((caught as ScreeningError).kind).toBe("permission");
    expect(callCount).toBe(1);
  });
});
