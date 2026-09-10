// 选股流程编排（service.ts）
//
// 执行顺序按「成本从低到高」排列，而不是按 C→A→N→S→L→I→M 的字母顺序。
// 由于各条件是合取关系，顺序不改变最终结果集，只改变接口调用量：
//
//   阶段 0  M 因子           本地，4 次指数查询
//   阶段 1  构造股票池        本地，排除 ST / 北交所 / 退市
//   阶段 2  L 因子 + RS 门槛  本地，5 个截面查询算全市场 RS，约 5000 → 1500
//   阶段 3  N / S 因子        本地，批量 K 线 + 当日截面，毫秒级
//   阶段 4  技术面预筛        本地，按 L/N/S 加权排序取前 maxFinancialFetch 名
//   阶段 5  C / A 因子        在线，逐只 fina_indicator（唯一的高成本环节）
//   阶段 6  财务门槛          本地
//   阶段 7  I 因子            在线，逐只 top10_floatholders + 批量 stk_holdernumber
//   阶段 8  综合评分与排序    本地
//
// 若把 C/A 放在最前面对全市场执行，需要约 5000 次单只调用，必然撞频控；
// 现在只需约 400 次，且有本地缓存，第二次运行接近零调用。

import type { Database } from "bun:sqlite";
import type { CanSlimConfig } from "./config";
import { resolveConfig } from "./config";
import type {
  CanSlimCandidate,
  CanSlimScreeningResult,
  FactorSet,
  ScreeningStats,
} from "./types";
import { degraded } from "./types";
import {
  getStockBasics,
  getBarsForCodes,
  getDailyBasicMap,
  resolveAsOfTradeDate,
} from "./repository";
import { computeMarketRegime } from "./factors/m-market";
import { computeLeaderFactors, buildUniverse, passRsGate } from "./factors/l-leader";
import { computeNewFactor } from "./factors/n-new";
import { computeSupplyFactor } from "./factors/s-supply";
import { computeCurrentEarningsFactor, passCurrentEarningsGate } from "./factors/c-current";
import { computeAnnualEarningsFactor, passAnnualEarningsGate } from "./factors/a-annual";
import { computeInstitutionFactor, computeHolderNumChange } from "./factors/i-institution";
import {
  ensureFinaIndicators,
  ensureTop10FloatHolders,
  ensureHolderNumbers,
  getVisibleFinaIndicatorsForCodes,
  getVisibleTop10Holders,
  getVisibleHolderNumbersForCodes,
} from "./financials";
import { assembleCandidate, rankCandidates, FACTOR_KEYS } from "./scoring";
import { CanSlimError } from "./types";

/** K 线窗口：52 周需要 250 根，多取一些冗余用于突破判定 */
const BAR_WINDOW = 270;

export interface RunOptions {
  /** 基准日；省略则用本地库最近可用交易日 */
  date?: string;
  /** 配置覆盖 */
  config?: Partial<CanSlimConfig>;
  /** 诊断日志接收数组 */
  logs?: string[];
  /**
   * 是否允许在线取数。设为 false 时只用本地已缓存的财务/机构数据，
   * 缺数据的因子降级——用于「快速出结果」或「离线复算历史日期」。
   */
  allowFetch?: boolean;
}

/** 创建带耗时的日志函数 */
function makeLogger(logs: string[]) {
  const t0 = Date.now();
  return (message: string) => {
    const line = `[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${message}`;
    logs.push(line);
    console.log(`[can-slim] ${line}`);
  };
}

/**
 * 执行一次完整的 CAN SLIM 选股。
 *
 * @throws CanSlimError 本地库为空或基准日无数据时抛出（调用方应引导用户先同步）
 */
export async function runCanSlimScreening(
  db: Database,
  options: RunOptions = {}
): Promise<CanSlimScreeningResult> {
  const logs = options.logs ?? [];
  const log = makeLogger(logs);
  const cfg = resolveConfig(options.config);
  const allowFetch = options.allowFetch ?? true;
  const warnings: string[] = [];

  // ===== 基准日 =====
  const requested = options.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const asOfDate = resolveAsOfTradeDate(db, requested);
  if (!asOfDate) {
    throw new CanSlimError(
      `本地库中没有不晚于 ${requested} 的行情数据，请先执行同步脚本`,
      undefined,
      "db"
    );
  }
  log(`基准日 ${asOfDate}${asOfDate !== requested ? `（请求 ${requested}，已回退到最近交易日）` : ""}`);

  // ===== 阶段 0：M 因子 =====
  log("阶段 0：计算 M 因子（市场环境）");
  const market = computeMarketRegime(db, asOfDate, cfg);
  const scoreThreshold = cfg.screen.scoreThreshold[market.regime];
  log(`M 因子：${market.regime}（综合分 ${market.score}），入选门槛 ${scoreThreshold}`);
  if (market.degradedReason) {
    warnings.push(`M 因子部分降级：${market.degradedReason}`);
  }
  if (market.regime === "BEAR") {
    warnings.push("大盘处于空头环境，本次不产生买入信号，输出结果仅供观察");
  }

  // ===== 阶段 1：构造股票池 =====
  const allStocks = getStockBasics(db);
  const { universe, excluded } = buildUniverse(allStocks, cfg);
  log(`阶段 1：股票池 ${allStocks.length} → ${universe.length}（排除 ${excluded.length} 只）`);

  const basicByCode = new Map(allStocks.map((s) => [s.ts_code, s]));

  // ===== 阶段 2：L 因子 + RS 硬门槛 =====
  log("阶段 2：计算 L 因子（全市场相对强度与行业强度）");
  const leader = computeLeaderFactors(db, asOfDate, cfg, universe);
  const rsPassed = [...leader.byCode.entries()]
    .filter(([, r]) => passRsGate(r, cfg))
    .map(([code]) => code);
  log(`L 因子完成：参与排名 ${leader.universeSize} 只，RS ≥ ${cfg.l.rsMin} 通过 ${rsPassed.length} 只`);

  if (rsPassed.length === 0) {
    log("无股票通过 RS 门槛，流程结束");
    return buildEmptyResult(asOfDate, market, scoreThreshold, leader.industries, {
      totalStocks: allStocks.length,
      universeSize: universe.length,
      afterRsGate: 0,
      afterFinancialGate: 0,
      candidates: 0,
      buySignals: 0,
      dataFetch: emptyFetchStats(),
      degradedCounts: {},
    }, warnings);
  }

  // ===== 阶段 3：N / S 因子（本地，零成本） =====
  log(`阶段 3：批量取 K 线并计算 N / S 因子（${rsPassed.length} 只）`);
  const barsMap = getBarsForCodes(db, rsPassed, asOfDate, BAR_WINDOW);
  const dailyBasicMap = getDailyBasicMap(db, asOfDate);

  const nFactors = new Map<string, ReturnType<typeof computeNewFactor>>();
  const sFactors = new Map<string, ReturnType<typeof computeSupplyFactor>>();
  for (const code of rsPassed) {
    const bars = barsMap.get(code) ?? [];
    nFactors.set(code, computeNewFactor(bars, cfg));
    // 股东户数在阶段 7 才取，这里先传 null；S 因子会把该子项权重摊给其余子项
    sFactors.set(code, computeSupplyFactor(bars, dailyBasicMap.get(code), null, cfg));
  }
  log("N / S 因子计算完成");

  // ===== 阶段 4：技术面预筛，收缩到财务层可承受的规模 =====
  const pw = cfg.screen.preScreenWeights;
  const preRanked = rsPassed
    .map((code) => {
      const l = leader.byCode.get(code)?.score ?? 0;
      const n = nFactors.get(code)?.score ?? 0;
      const s = sFactors.get(code)?.score ?? 0;
      return { code, techScore: l * pw.l + n * pw.n + s * pw.s };
    })
    .sort((a, b) => b.techScore - a.techScore);

  const financialCandidates = preRanked
    .slice(0, cfg.screen.maxFinancialFetch)
    .map((x) => x.code);
  log(
    `阶段 4：技术面预筛（L${pw.l * 100}% / N${pw.n * 100}% / S${pw.s * 100}%），` +
      `${rsPassed.length} → ${financialCandidates.length} 只进入财务层`
  );

  // ===== 阶段 5：C / A 因子（在线取数） =====
  const fetchStats = emptyFetchStats();
  let financialDegradedGlobally = false;

  if (allowFetch) {
    log(`阶段 5：拉取财务指标（${financialCandidates.length} 只，命中缓存的不重复调用）`);
    const finaResult = await ensureFinaIndicators(
      db,
      financialCandidates,
      asOfDate,
      (done, total) => log(`  财务数据进度 ${done}/${total}`)
    );
    fetchStats.finaIndicator = {
      fetched: finaResult.fetched,
      cached: finaResult.cached,
      failed: finaResult.failed,
    };
    log(
      `财务指标：在线拉取 ${finaResult.fetched} 只，缓存命中 ${finaResult.cached} 只，失败 ${finaResult.failed} 只`
    );

    if (finaResult.permissionDenied) {
      financialDegradedGlobally = true;
      warnings.push(
        `C / A 因子整体降级：fina_indicator 接口权限不足（${finaResult.firstError ?? "需 2000 积分"}）。` +
          "当前结果退化为 N / S / L 技术面选股，不再是完整的 CAN SLIM 成长股筛选，请谨慎解读。"
      );
      log("⚠️ fina_indicator 权限不足，C / A 因子整体降级");
    } else if (finaResult.failed > 0) {
      warnings.push(`${finaResult.failed} 只股票的财务数据拉取失败，这些股票的 C / A 因子已降级`);
    }
  } else {
    log("阶段 5：未启用在线取数，仅使用本地缓存的财务数据");
  }

  const finaByCode = getVisibleFinaIndicatorsForCodes(db, financialCandidates, asOfDate);

  // 缓存覆盖不足时给出明确引导。这不是错误——离线预热是设计上的选择，
  // 但用户需要知道「为什么很多股票的 C/A 是灰的」以及怎么补。
  const missingFinancials = financialCandidates.filter(
    (code) => (finaByCode.get(code)?.length ?? 0) === 0
  );
  if (missingFinancials.length > 0) {
    const coverPct = (
      ((financialCandidates.length - missingFinancials.length) / financialCandidates.length) *
      100
    ).toFixed(0);
    warnings.push(
      `${missingFinancials.length} / ${financialCandidates.length} 只候选缺少财务数据缓存（覆盖率 ${coverPct}%），` +
        "这些股票的 C / A 因子已降级。" +
        (allowFetch
          ? ""
          : "执行 bun run src/scripts/sync-financials.ts 可预热财务数据（约 2.5 分钟）。")
    );
    log(`⚠️ ${missingFinancials.length} 只候选缺少财务缓存，C / A 因子降级`);
  }
  const cFactors = new Map<string, FactorSet["c"]>();
  const aFactors = new Map<string, FactorSet["a"]>();

  for (const code of financialCandidates) {
    const periods = finaByCode.get(code) ?? [];
    if (financialDegradedGlobally) {
      cFactors.set(code, degraded("fina_indicator 接口权限不足"));
      aFactors.set(code, degraded("fina_indicator 接口权限不足"));
    } else {
      cFactors.set(code, computeCurrentEarningsFactor(periods, cfg));
      aFactors.set(code, computeAnnualEarningsFactor(periods, cfg));
    }
  }
  log("C / A 因子计算完成");

  // ===== 阶段 6：财务硬门槛 =====
  // 财务因子整体降级时不能用它做门槛（否则会把全部候选筛空），此时只保留技术面门槛
  const financialPassed = financialDegradedGlobally
    ? financialCandidates
    : financialCandidates.filter(
        (code) =>
          passCurrentEarningsGate(cFactors.get(code), cfg) &&
          passAnnualEarningsGate(aFactors.get(code), cfg)
      );
  log(
    `阶段 6：财务硬门槛（C: 单季扣非净利同比 ≥ ${cfg.c.quarterlyProfitYoyMin}%、` +
      `A: ${cfg.a.cagrYears} 年 EPS CAGR ≥ ${cfg.a.epsCagrMin}%），` +
      `${financialCandidates.length} → ${financialPassed.length} 只` +
      (financialDegradedGlobally ? "（因子降级，门槛已跳过）" : "")
  );

  // ===== 阶段 7：I 因子（在线取数） =====
  // 按技术面分数排序后取前若干名，控制逐只接口的调用量
  const institutionCandidates = preRanked
    .filter((x) => financialPassed.includes(x.code))
    .slice(0, cfg.screen.maxInstitutionFetch)
    .map((x) => x.code);

  let institutionDegradedGlobally = false;
  if (allowFetch && institutionCandidates.length > 0) {
    log(`阶段 7：拉取机构持仓与股东户数（${institutionCandidates.length} 只）`);
    const holdersResult = await ensureTop10FloatHolders(
      db,
      institutionCandidates,
      asOfDate,
      (done, total) => log(`  机构持仓进度 ${done}/${total}`)
    );
    fetchStats.top10Holders = {
      fetched: holdersResult.fetched,
      cached: holdersResult.cached,
      failed: holdersResult.failed,
    };

    if (holdersResult.permissionDenied) {
      institutionDegradedGlobally = true;
      warnings.push(
        `I 因子整体降级：top10_floatholders 接口权限不足（${holdersResult.firstError ?? "需 2000 积分"}），` +
          "其权重已按比例摊给其余因子。"
      );
      log("⚠️ top10_floatholders 权限不足，I 因子整体降级");
    }

    // 股东户数：按月分段批量拉取，成本远低于逐只
    const holderNumResult = await ensureHolderNumbers(db, asOfDate);
    fetchStats.holderNumbers = {
      fetched: holderNumResult.fetched,
      cached: holderNumResult.cached,
      failed: holderNumResult.failed,
    };
    if (holderNumResult.permissionDenied) {
      warnings.push("股东户数接口权限不足，该子项不参与 S / I 评分");
    }
    log(
      `机构数据：持仓 ${holdersResult.fetched} 只在线 / ${holdersResult.cached} 只缓存，` +
        `股东户数 ${holderNumResult.fetched} 个窗口在线 / ${holderNumResult.cached} 个缓存`
    );
  } else if (!allowFetch) {
    log("阶段 7：已禁用在线取数，仅使用本地缓存的机构数据");
  }

  const holderNumsByCode = getVisibleHolderNumbersForCodes(db, financialPassed, asOfDate);

  // ===== 阶段 8：组装、评分、排序 =====
  log(`阶段 8：组装候选并综合评分（${financialPassed.length} 只）`);
  const candidates: CanSlimCandidate[] = [];

  for (const code of financialPassed) {
    const stock = basicByCode.get(code);
    const bars = barsMap.get(code) ?? [];
    const basic = dailyBasicMap.get(code);
    if (!stock || bars.length === 0) continue;

    const last = bars[bars.length - 1]!;
    const holderNums = holderNumsByCode.get(code);
    const holderChange = holderNums ? computeHolderNumChange(holderNums) : null;

    // I 因子：只对实际拉取过的候选计算
    let iFactor: FactorSet["i"];
    if (institutionDegradedGlobally) {
      iFactor = degraded("top10_floatholders 接口权限不足");
    } else if (institutionCandidates.includes(code)) {
      const holdersByPeriod = getVisibleTop10Holders(db, code, asOfDate);
      iFactor = computeInstitutionFactor(holdersByPeriod, holderNums, cfg);
    } else {
      iFactor = degraded(
        `未进入机构数据取数范围（按技术面评分取前 ${cfg.screen.maxInstitutionFetch} 名）`
      );
    }

    // S 因子重算一次，把股东户数子项纳入
    const sFactor = holderChange
      ? computeSupplyFactor(bars, basic, holderChange, cfg)
      : (sFactors.get(code) ?? degraded("供需数据不可用"));

    const factors: FactorSet = {
      c: cFactors.get(code) ?? degraded("未取到财务数据"),
      a: aFactors.get(code) ?? degraded("未取到财务数据"),
      n: nFactors.get(code) ?? degraded("未计算"),
      s: sFactor,
      l: leader.byCode.get(code) ?? degraded("未计算"),
      i: iFactor,
    };

    candidates.push(
      assembleCandidate(
        {
          ts_code: code,
          name: stock.name,
          industry: stock.industry,
          market: stock.market,
          close: last.close,
          pctChg: last.pct_chg,
          limitStatus: basic?.limit_status ?? null,
          bars,
        },
        factors,
        market.regime,
        cfg
      )
    );
  }

  // 达到门槛的才算入选；未达门槛的作为观察列表（不返回，避免噪声）
  const qualified = candidates.filter((c) => c.totalScore >= scoreThreshold);
  const ranked = rankCandidates(qualified.length > 0 ? qualified : candidates, cfg);
  const buySignals = ranked.filter((c) => c.buySignal !== null).length;

  if (qualified.length === 0 && candidates.length > 0) {
    warnings.push(
      `没有股票达到当前市场环境的入选门槛 ${scoreThreshold} 分，` +
        `已返回评分最高的 ${ranked.length} 只作为观察列表（不构成买入信号）。`
    );
  }

  // 统计各因子降级数量
  const degradedCounts: Record<string, number> = {};
  for (const key of FACTOR_KEYS) {
    degradedCounts[key] = candidates.filter((c) =>
      c.degradedFactors.some((d) => d.factor === key)
    ).length;
  }

  const stats: ScreeningStats = {
    totalStocks: allStocks.length,
    universeSize: universe.length,
    afterRsGate: rsPassed.length,
    afterFinancialGate: financialPassed.length,
    candidates: ranked.length,
    buySignals,
    dataFetch: fetchStats,
    degradedCounts,
  };

  log(
    `选股完成：候选 ${ranked.length} 只（达门槛 ${qualified.length} 只），买入信号 ${buySignals} 个`
  );

  return {
    asOfDate,
    market,
    scoreThreshold,
    candidates: ranked,
    industries: leader.industries.slice(0, 30),
    stats,
    warnings,
  };
}

/** 空的取数统计 */
function emptyFetchStats(): ScreeningStats["dataFetch"] {
  return {
    finaIndicator: { fetched: 0, cached: 0, failed: 0 },
    top10Holders: { fetched: 0, cached: 0, failed: 0 },
    holderNumbers: { fetched: 0, cached: 0, failed: 0 },
  };
}

/** 构造无候选时的返回结构 */
function buildEmptyResult(
  asOfDate: string,
  market: CanSlimScreeningResult["market"],
  scoreThreshold: number,
  industries: CanSlimScreeningResult["industries"],
  stats: ScreeningStats,
  warnings: string[]
): CanSlimScreeningResult {
  return {
    asOfDate,
    market,
    scoreThreshold,
    candidates: [],
    industries: industries.slice(0, 30),
    stats,
    warnings,
  };
}
