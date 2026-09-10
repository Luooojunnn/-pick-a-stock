// N 因子：新高与新催化（New）
//
// N 是 CAN SLIM 里最难完全量化的一项，原始含义包含新产品、新管理层、新行业机会、
// 新商业模式、新高价、新的重大催化。Tushare 无法可靠识别前几项，
// 因此按规格第 4 节拆成两个可量化部分：
//
//   N = New High（价格位置）+ Breakout（突破确认）
//
// 基本面催化（新产品、新管理层等）保留 CatalystProvider 接口，第一版不实现——
// 与其用关键词匹配公告标题伪装成精确指标，不如明确标注这部分未纳入。
//
// 一个容易被误解的点：贴近 52 周新高不是风险信号，而是 CAN SLIM 明确偏好的特征。
// O'Neil 的统计结论是强势股倾向于在新高附近继续走强，而「便宜」的破位股往往继续弱。
//
// 全部计算使用复权价（adjClose / adjHigh）。不复权价在除权日会凭空跳空，
// 52 周最高价会被虚高的历史价格污染，突破判定也会失效。

import type { Bar } from "../repository";
import type { CanSlimConfig } from "../config";
import type { FactorResult } from "../types";
import { degraded } from "../types";

/**
 * 基本面催化数据提供者（预留接口，第一版无实现）。
 *
 * 后续可接入 anns_d（公告）、forecast（业绩预告）、express（业绩快报）、
 * research_report（券商研报）等，把「新产品 / 新订单 / 大幅预增」这类事件纳入 N。
 */
export interface CatalystProvider {
  /** 返回该股在基准日之前的催化事件描述；实现方需自行保证不使用未来数据 */
  getCatalysts(tsCode: string, asOfDate: string): Promise<string[]>;
}

/** 突破判定结果 */
interface BreakoutVerdict {
  /** 被突破的最长窗口（交易日）；null 表示未突破任何窗口 */
  lookback: number | null;
  /** 该窗口对应的基础分 */
  baseScore: number;
  /** 突破当日量能相对均量的倍数 */
  volumeRatio: number;
  /** 量能是否达标 */
  volumeConfirmed: boolean;
  /** 各窗口的突破情况，用于明细输出 */
  perWindow: { lookback: number; broke: boolean; priorHigh: number }[];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 判定突破：当日复权收盘价是否高于「此前 N 个交易日」的最高价。
 *
 * 注意窗口不含当日——否则当日自身的高点会让突破永远不成立。
 */
function judgeBreakout(bars: Bar[], cfg: CanSlimConfig): BreakoutVerdict {
  const { breakoutLookbacks, breakoutScores, noBreakoutScore, volumeMaDaysForBreakout } = {
    ...cfg.n,
    volumeMaDaysForBreakout: cfg.s.volumeMaDays,
  };

  const last = bars[bars.length - 1]!;
  const prior = bars.slice(0, -1); // 不含当日

  // 均量：当日之前 volumeMaDays 根的平均成交量
  const volWindow = prior.slice(-volumeMaDaysForBreakout);
  const avgVol =
    volWindow.length > 0 ? volWindow.reduce((s, b) => s + b.vol, 0) / volWindow.length : 0;
  const volumeRatio = avgVol > 0 ? last.vol / avgVol : 0;
  const volumeConfirmed = volumeRatio >= cfg.n.breakoutVolumeRatio;

  const perWindow: { lookback: number; broke: boolean; priorHigh: number }[] = [];
  let bestLookback: number | null = null;
  let bestScore = noBreakoutScore;

  for (let i = 0; i < breakoutLookbacks.length; i++) {
    const lb = breakoutLookbacks[i]!;
    const window = prior.slice(-lb);
    if (window.length === 0) {
      perWindow.push({ lookback: lb, broke: false, priorHigh: 0 });
      continue;
    }
    const priorHigh = Math.max(...window.map((b) => b.adjHigh));
    const broke = last.adjClose > priorHigh;
    perWindow.push({ lookback: lb, broke, priorHigh });

    // 取被突破的最长窗口（含义更强）
    if (broke) {
      bestLookback = lb;
      bestScore = breakoutScores[i] ?? bestScore;
    }
  }

  return { lookback: bestLookback, baseScore: bestScore, volumeRatio, volumeConfirmed, perWindow };
}

/**
 * 计算 N 因子。
 *
 * @param bars 升序复权 K 线，末位为基准日。需至少 yearTradingDays 根才能算 52 周高点
 * @param cfg 生效配置
 */
export function computeNewFactor(bars: Bar[], cfg: CanSlimConfig): FactorResult {
  const {
    yearTradingDays,
    near52wHighStrong,
    near52wHighOk,
    far52wHighPenalty,
    nearHighFloor,
    weakVolumeDiscount,
    nearHighWeight,
    breakoutWeight,
    new52wHighBonus,
    breakoutVolumeRatio,
  } = cfg.n;

  if (bars.length < yearTradingDays) {
    return degraded(
      `仅有 ${bars.length} 个交易日数据（需 ${yearTradingDays}），无法计算 52 周高点`
    );
  }

  const last = bars[bars.length - 1]!;
  // 52 周窗口（含当日）：取最近 yearTradingDays 根
  const yearWindow = bars.slice(-yearTradingDays);
  const high52w = Math.max(...yearWindow.map((b) => b.adjHigh));
  const low52w = Math.min(...yearWindow.map((b) => b.adjLow));

  if (high52w <= 0) {
    return degraded("52 周内无有效价格数据");
  }

  const ratio = last.adjClose / high52w;
  // 是否正在创 52 周新高（当日最高即区间最高）
  const isNew52wHigh = last.adjHigh >= high52w - 1e-9;

  // 距高点位置映射为 0–100：nearHighFloor 处记 0，等于高点记 100
  const nearHighScore = clamp(
    ((ratio - nearHighFloor) / (1 - nearHighFloor)) * 100,
    0,
    100
  );

  const breakout = judgeBreakout(bars, cfg);
  // 缩量突破打折：突破本身有效，但没有量能确认，说服力不足
  const breakoutScore =
    breakout.lookback !== null && !breakout.volumeConfirmed
      ? breakout.baseScore * weakVolumeDiscount
      : breakout.baseScore;

  const score = clamp(
    nearHighScore * nearHighWeight +
      breakoutScore * breakoutWeight +
      (isNew52wHigh ? new52wHighBonus : 0),
    0,
    100
  );

  // ===== 可解释明细 =====
  const details: string[] = [];
  const distancePct = (1 - ratio) * 100;

  if (isNew52wHigh) {
    details.push(`正在创 52 周新高（复权价 ${last.adjClose.toFixed(2)}）`);
  } else if (ratio >= near52wHighStrong) {
    details.push(`距 52 周高点仅 ${distancePct.toFixed(1)}%，贴近新高`);
  } else if (ratio >= near52wHighOk) {
    details.push(`距 52 周高点 ${distancePct.toFixed(1)}%，处于高位`);
  } else if (ratio < far52wHighPenalty) {
    details.push(
      `距 52 周高点 ${distancePct.toFixed(1)}%，已远离新高（低于高点 ${((1 - far52wHighPenalty) * 100).toFixed(0)}% 以上）`
    );
  } else {
    details.push(`距 52 周高点 ${distancePct.toFixed(1)}%`);
  }

  // 52 周振幅位置，帮助判断是「高位横盘」还是「刚从底部起来」
  if (high52w > low52w) {
    const positionInRange = ((last.adjClose - low52w) / (high52w - low52w)) * 100;
    details.push(`处于 52 周区间的 ${positionInRange.toFixed(0)}% 位置`);
  }

  if (breakout.lookback !== null) {
    const volText = breakout.volumeConfirmed
      ? `成交量为 ${cfg.s.volumeMaDays} 日均量的 ${breakout.volumeRatio.toFixed(2)} 倍，量能确认`
      : `但成交量仅为 ${cfg.s.volumeMaDays} 日均量的 ${breakout.volumeRatio.toFixed(2)} 倍，` +
        `未达 ${breakoutVolumeRatio} 倍，属缩量突破（得分打 ${(weakVolumeDiscount * 100).toFixed(0)}% 折）`;
    details.push(`突破 ${breakout.lookback} 日新高，${volText}`);
  } else {
    details.push("当日未突破 20/50/120 日新高");
  }

  const metrics: Record<string, number | string | null> = {
    high52w: Math.round(high52w * 100) / 100,
    low52w: Math.round(low52w * 100) / 100,
    distanceTo52wHighPct: Math.round(distancePct * 100) / 100,
    ratioTo52wHigh: Math.round(ratio * 10000) / 10000,
    isNew52wHigh: isNew52wHigh ? 1 : 0,
    nearHighScore: Math.round(nearHighScore * 10) / 10,
    breakoutLookback: breakout.lookback,
    breakoutScore: Math.round(breakoutScore * 10) / 10,
    breakoutVolumeRatio: Math.round(breakout.volumeRatio * 100) / 100,
    breakoutVolumeConfirmed: breakout.volumeConfirmed ? 1 : 0,
  };
  for (const w of breakout.perWindow) {
    metrics[`broke${w.lookback}`] = w.broke ? 1 : 0;
  }

  return { score, details, metrics };
}

/**
 * 判断是否构成「突破买入信号」的价格与量能条件。
 *
 * 规格第 10 节：第一版只实现最简单的突破——
 * 收盘突破 20/50 日最高价，且成交量 ≥ 20 日均量 × 1.4。
 * 形态识别（Cup with Handle 等）不在第一版范围。
 */
export function isBreakoutBuySetup(bars: Bar[], cfg: CanSlimConfig): boolean {
  if (bars.length < cfg.s.volumeMaDays + 2) return false;
  const breakout = judgeBreakout(bars, cfg);
  if (breakout.lookback === null) return false;
  // 买入信号要求突破窗口至少 20 日，且量能达标
  return breakout.lookback >= 20 && breakout.volumeConfirmed;
}
