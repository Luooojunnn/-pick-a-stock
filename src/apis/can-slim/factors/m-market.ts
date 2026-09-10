// M 因子：市场环境（Market Direction）
//
// O'Neil 的核心主张：大盘走坏时，再优秀的个股也应降低仓位或停止买入。
// 因此 M 不作为个股总分的一项，而是「开关」——它决定入选门槛的高低，
// 以及熊市里是否还产生买入信号。这一点与规格第 8、9 节一致。
//
// 判定方法（每个指数独立判定，再综合）：
// - 收盘价在 MA50 上方，且 MA50 在 MA200 上方  → BULL
// - 收盘价在 MA50 下方，且 MA50 在 MA200 下方  → BEAR
// - 两条均线过于接近（相对差异小于阈值）      → NEUTRAL（趋势不明）
// - 其余混合状态                              → NEUTRAL
//
// 综合方式：每个指数按三态折算分值（100/60/20）后取平均，再按阈值映射为整体三态。
// 相比「简单多数投票」，平均分在 2:2 分歧时不会产生歧义，且输出的连续分值本身可解释。

import type { Database } from "bun:sqlite";
import { getIndexBars, sma } from "../repository";
import type { CanSlimConfig, MarketRegime } from "../config";
import type { MarketRegimeResult } from "../types";

/** 单指数判定结果 */
interface SingleIndexVerdict {
  ts_code: string;
  name: string;
  close: number;
  maShort: number | null;
  maLong: number | null;
  regime: MarketRegime;
  nearHighRatio: number | null;
  note: string;
}

/**
 * 判定单个指数的市场状态。
 *
 * @param bars 升序指数日线（至少需要 maLong 根才能给出完整判定）
 */
function judgeIndex(
  tsCode: string,
  name: string,
  bars: { trade_date: string; close: number; high: number }[],
  cfg: CanSlimConfig
): SingleIndexVerdict {
  const { maShort, maLong, maConvergenceThreshold } = cfg.m;

  if (bars.length === 0) {
    return {
      ts_code: tsCode,
      name,
      close: 0,
      maShort: null,
      maLong: null,
      regime: "NEUTRAL",
      nearHighRatio: null,
      note: "本地库无该指数数据",
    };
  }

  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1]!;
  const shortSeries = sma(closes, maShort);
  const longSeries = sma(closes, maLong);
  const ma50 = shortSeries[shortSeries.length - 1] ?? null;
  const ma200 = longSeries[longSeries.length - 1] ?? null;

  // 距区间最高点的比例（用于「指数是否接近新高」的辅助说明）
  const highest = Math.max(...bars.map((b) => b.high));
  const nearHighRatio = highest > 0 ? last / highest : null;

  // MA200 不可用时只能退化为「价格 vs MA50」的弱判定
  if (ma200 === null) {
    if (ma50 === null) {
      return {
        ts_code: tsCode,
        name,
        close: last,
        maShort: null,
        maLong: null,
        regime: "NEUTRAL",
        nearHighRatio,
        note: `历史不足 ${maShort} 个交易日，无法判定趋势`,
      };
    }
    const regime: MarketRegime = last > ma50 ? "BULL" : "BEAR";
    return {
      ts_code: tsCode,
      name,
      close: last,
      maShort: ma50,
      maLong: null,
      regime,
      nearHighRatio,
      note: `历史不足 ${maLong} 个交易日，仅按价格与 MA${maShort} 关系弱判定`,
    };
  }

  const aboveShort = last > (ma50 ?? 0);
  const shortAboveLong = (ma50 ?? 0) > ma200;
  // 两条均线相对差异过小 → 趋势不明
  const converged = Math.abs((ma50 ?? 0) - ma200) / ma200 < maConvergenceThreshold;

  let regime: MarketRegime;
  let note: string;

  if (converged) {
    regime = "NEUTRAL";
    note = `MA${maShort} 与 MA${maLong} 相差不足 ${(maConvergenceThreshold * 100).toFixed(0)}%，趋势不明`;
  } else if (aboveShort && shortAboveLong) {
    regime = "BULL";
    note = `收盘在 MA${maShort} 上方且 MA${maShort} 在 MA${maLong} 上方，多头排列`;
  } else if (!aboveShort && !shortAboveLong) {
    regime = "BEAR";
    note = `收盘在 MA${maShort} 下方且 MA${maShort} 在 MA${maLong} 下方，空头排列`;
  } else if (aboveShort && !shortAboveLong) {
    regime = "NEUTRAL";
    note = `收盘已站上 MA${maShort}，但 MA${maShort} 仍在 MA${maLong} 下方，趋势修复中`;
  } else {
    regime = "NEUTRAL";
    note = `MA${maShort} 在 MA${maLong} 上方但收盘跌破 MA${maShort}，趋势走弱`;
  }

  return { ts_code: tsCode, name, close: last, maShort: ma50, maLong: ma200, regime, nearHighRatio, note };
}

/**
 * 计算市场环境（M 因子）。
 *
 * @param db 本地库连接
 * @param asOfDate 基准日，强制只使用该日及之前的数据
 * @param cfg 生效配置
 */
export function computeMarketRegime(
  db: Database,
  asOfDate: string,
  cfg: CanSlimConfig
): MarketRegimeResult {
  const { indexes, maLong, regimeScores, bullThreshold, neutralThreshold } = cfg.m;

  const verdicts: SingleIndexVerdict[] = [];
  for (const idx of indexes) {
    // 多取一些冗余（maLong + 60），保证 MA200 序列末位有值
    const bars = getIndexBars(db, idx.ts_code, asOfDate, maLong + 60);
    verdicts.push(judgeIndex(idx.ts_code, idx.name, bars, cfg));
  }

  // 只有拿到 MA200 的指数才算「有效判定」，用于决定是否整体降级
  const valid = verdicts.filter((v) => v.maLong !== null);
  const scoreOf = (r: MarketRegime) =>
    r === "BULL" ? regimeScores.bull : r === "BEAR" ? regimeScores.bear : regimeScores.neutral;

  // 全部指数都缺长期均线：给出 NEUTRAL 并说明原因，不阻断选股流程
  if (valid.length === 0) {
    const avgWeak =
      verdicts.length > 0
        ? verdicts.reduce((s, v) => s + scoreOf(v.regime), 0) / verdicts.length
        : regimeScores.neutral;
    return {
      regime: "NEUTRAL",
      score: Math.round(avgWeak),
      indexes: verdicts,
      summary: `本地库指数历史不足 ${maLong} 个交易日，无法可靠判定大盘趋势，按中性处理`,
      degradedReason: `指数历史不足 ${maLong} 个交易日`,
    };
  }

  const score = valid.reduce((s, v) => s + scoreOf(v.regime), 0) / valid.length;
  const regime: MarketRegime =
    score >= bullThreshold ? "BULL" : score >= neutralThreshold ? "NEUTRAL" : "BEAR";

  const bullCount = valid.filter((v) => v.regime === "BULL").length;
  const bearCount = valid.filter((v) => v.regime === "BEAR").length;
  const neutralCount = valid.length - bullCount - bearCount;

  const regimeText =
    regime === "BULL" ? "多头（BULL）" : regime === "BEAR" ? "空头（BEAR）" : "中性（NEUTRAL）";
  const action =
    regime === "BULL"
      ? "可正常执行选股"
      : regime === "NEUTRAL"
        ? "只取高分标的并降低仓位"
        : "不产生买入信号，仅输出观察列表";

  return {
    regime,
    score: Math.round(score),
    indexes: verdicts,
    summary:
      `大盘环境：${regimeText}，综合分 ${Math.round(score)}` +
      `（${valid.length} 个指数中多头 ${bullCount} / 中性 ${neutralCount} / 空头 ${bearCount}）。${action}。`,
    degradedReason:
      valid.length < verdicts.length
        ? `${verdicts.length - valid.length} 个指数历史不足 ${maLong} 个交易日，未参与判定`
        : undefined,
  };
}
