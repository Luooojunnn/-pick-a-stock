// 数据获取层集成测试（data-source.integration.test.ts）
// 通过注入 mock 版 callTushare（__setCallTushare）隔离网络，验证 data-source 层的
// 超时/重试/权限识别/空结果判定策略，以及失败时错误携带正确接口名的行为。
//
// 覆盖需求：
// - 10.4：接口返回错误或超时 → 中止筛选，错误信息包含失败接口名称与原因。
// - 10.6：账号权限不足 → 不重试、立即中止，返回权限类错误（含接口名）。
// - 4.5：换手率场景（daily_basic，10s 超时）接口失败 → 上抛错误、保留调用前候选集不变。
// - 5.5：流通市值场景（daily_basic，30s 超时）接口失败 → 上抛错误、保留调用前候选集不变。
//
// 说明：候选集"保留不变"的语义由调用方（pipeline/service）承担；本层只负责在失败时
// 上抛携带正确 apiName 的 ScreeningError，从而让上层能够中止并保留原候选集。因此这里
// 聚焦断言「失败上抛且 apiName 正确」。为控制测试时长，统一使用较短 timeoutMs 与较少
// maxRetries，避免命中真实的 30s/10s 超时与 1s 重试间隔。

import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchWithPolicy,
  fetchStockBasic,
  fetchDailyBasicByDate,
  __setCallTushare,
  __resetCallTushare,
} from "./data-source";
import { ScreeningError } from "./types";

// 每个用例后恢复真实实现，避免 mock 泄漏影响其它测试
afterEach(() => {
  __resetCallTushare();
});

describe("fetchWithPolicy：失败中止与错误接口名（需求 10.4）", () => {
  test("持续瞬时失败、重试耗尽后中止，抛出携带失败接口名的 ScreeningError", async () => {
    let calls = 0;
    // 始终抛出网络类瞬时错误
    __setCallTushare(async () => {
      calls++;
      throw new Error("network error: fetch failed");
    });

    // maxRetries=0 以避免 1s 重试间隔，聚焦"中止并携带接口名"这一断言
    const promise = fetchWithPolicy(
      "daily",
      { trade_date: "20240101" },
      "ts_code,close",
      { timeoutMs: 50, maxRetries: 0 }
    );

    await expect(promise).rejects.toBeInstanceOf(ScreeningError);
    try {
      await fetchWithPolicy(
        "daily",
        { trade_date: "20240101" },
        "ts_code,close",
        { timeoutMs: 50, maxRetries: 0 }
      );
    } catch (err) {
      const e = err as ScreeningError;
      // 错误信息与 apiName 均应包含失败接口名（需求 10.4）
      expect(e.message).toContain("daily");
      expect(e.apiName).toBe("daily");
    }
    // maxRetries=0：两次调用各触发一次底层调用
    expect(calls).toBe(2);
  });

  test("持续超时（底层永不返回）→ 抛出 kind='timeout' 且携带失败接口名的错误", async () => {
    // 永不 resolve/reject，交由本层超时逻辑中止
    __setCallTushare(() => new Promise(() => {}));

    try {
      await fetchWithPolicy(
        "daily_basic",
        { trade_date: "20240101" },
        "ts_code,turnover_rate",
        { timeoutMs: 30, maxRetries: 0 }
      );
      throw new Error("预期应抛出超时错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      expect(e.kind).toBe("timeout");
      expect(e.apiName).toBe("daily_basic");
      expect(e.message).toContain("daily_basic");
    }
  });

  test("瞬时错误会重试指定次数后再中止（相邻重试后仍失败）", async () => {
    let calls = 0;
    __setCallTushare(async () => {
      calls++;
      throw new Error("ETIMEDOUT socket hang up");
    });

    // maxRetries=1：首次 + 1 次重试 = 共 2 次底层调用（含一次 1s 间隔）
    await expect(
      fetchWithPolicy("daily", { ts_code: "600000.SH" }, "ts_code,close", {
        timeoutMs: 30,
        maxRetries: 1,
      })
    ).rejects.toBeInstanceOf(ScreeningError);

    expect(calls).toBe(2);
  });
});

describe("fetchWithPolicy：权限不足不重试（需求 10.6）", () => {
  test("权限不足错误 → 抛出 kind='permission'，不重试且携带接口名", async () => {
    let calls = 0;
    __setCallTushare(async () => {
      calls++;
      // 命中权限关键字（"权限访问"/"没有接口访问权限"）
      throw new Error("抱歉，您没有接口访问权限，需要相应积分");
    });

    try {
      await fetchWithPolicy(
        "daily_basic",
        { trade_date: "20240101" },
        "ts_code,circ_mv",
        { timeoutMs: 50, maxRetries: 3 }
      );
      throw new Error("预期应抛出权限错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      expect(e.kind).toBe("permission");
      expect(e.apiName).toBe("daily_basic");
      expect(e.message).toContain("daily_basic");
    }

    // 权限不足不重试：即便 maxRetries=3，底层也只应调用一次
    expect(calls).toBe(1);
  });
});

describe("fetchStockBasic：空结果与失败判定", () => {
  test("stock_basic 返回空数组 → 抛出 kind='empty' 的 ScreeningError（需求 1.6）", async () => {
    __setCallTushare(async () => []);

    try {
      await fetchStockBasic();
      throw new Error("预期应抛出空结果错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      expect(e.kind).toBe("empty");
      expect(e.apiName).toBe("stock_basic");
      expect(e.message).toContain("stock_basic");
    }
  });

  test("stock_basic 接口失败 → 上抛错误且 apiName 为 stock_basic（需求 10.4）", async () => {
    // 非瞬时错误：直接中止，无重试间隔
    __setCallTushare(async () => {
      throw new Error("Tushare API error [2002]: 系统繁忙");
    });

    try {
      await fetchStockBasic();
      throw new Error("预期应抛出接口失败错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      expect(e.apiName).toBe("stock_basic");
      expect(e.message).toContain("stock_basic");
    }
  });
});

describe("fetchDailyBasicByDate：换手率/流通市值场景失败上抛（需求 4.5、5.5）", () => {
  test("换手率场景（daily_basic）持续失败 → 上抛错误、apiName 为 daily_basic（需求 4.5）", async () => {
    __setCallTushare(async () => {
      throw new Error("network error: fetch failed");
    });

    try {
      // 模拟换手率场景使用较短超时；maxRetries=0 控制测试时长
      await fetchDailyBasicByDate("20240101", { timeoutMs: 50, maxRetries: 0 });
      throw new Error("预期应抛出换手率数据获取失败错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      // 上抛错误供上层中止并保留调用前候选集不变（需求 4.5）
      expect(e.apiName).toBe("daily_basic");
      expect(e.message).toContain("daily_basic");
    }
  });

  test("流通市值场景（daily_basic）接口失败 → 上抛错误、apiName 为 daily_basic（需求 5.5）", async () => {
    __setCallTushare(async () => {
      throw new Error("Tushare API error [40203]: 抱歉，服务异常");
    });

    try {
      await fetchDailyBasicByDate("20240101", { timeoutMs: 50, maxRetries: 0 });
      throw new Error("预期应抛出流通市值数据获取失败错误，但调用成功返回");
    } catch (err) {
      expect(err).toBeInstanceOf(ScreeningError);
      const e = err as ScreeningError;
      // 上抛错误供上层中止并保留调用前候选集不变（需求 5.5）
      expect(e.apiName).toBe("daily_basic");
      expect(e.message).toContain("daily_basic");
    }
  });
});
