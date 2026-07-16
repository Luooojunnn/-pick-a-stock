// 筛选管线（pipeline.ts）
// 对应 design.md「筛选管线（pipeline.ts）与各 filter」「筛选管线顺序设计」章节。
//
// 职责：把 filters/ 下的各纯函数按既定顺序串联，逐股短路缩小候选集，并把每次排除
// 写入诊断记录。本模块不产生任何 I/O：数据（基准日截面、历史序列）由 service 层拉取
// 后以参数传入，pipeline 只做纯粹的判定与编排，便于单元测试与属性测试。
//
// 分两阶段：
//   阶段 A（全市场截面，低成本）：主板 → 涨幅 → 量比 → 换手率 → 流通市值
//   阶段 B（历史序列，高成本）：成交量递增（分级）→ 均线趋势（分级）

import type {
  StockBasicRow,
  DailyRow,
  DailyBasicRow,
  WorkingCandidate,
  CandidateStock,
  ExclusionRecord,
} from "./types";
import { recordExclusion } from "./filters/common";
import { isMainBoard } from "./filters/main-board";
import { applyPctChg } from "./filters/pct-chg";
import { applyVolumeRatio } from "./filters/volume-ratio";
import { applyTurnoverRate } from "./filters/turnover-rate";
import { applyCircMv } from "./filters/circ-mv";
import { classifyVolume } from "./filters/volume-increasing";
import { classifyMaTrend } from "./filters/ma-trend";

/**
 * 阶段 A：全市场截面筛选（需求 1.2–1.4、2.2–2.3、3.2–3.3、4.2–4.3、5.2–5.3）。
 *
 * 按 主板 → 涨幅 → 量比 → 换手率 → 流通市值 的顺序对每只股票串联判定，
 * 任一 filter 判定排除即短路（不再执行后续 filter），并写入一条诊断记录。
 * 主板判定为纯字符串判定，作为第一道且成本最低的过滤，最大化缩减基数。
 *
 * @param stocks 全量上市股票（stock_basic）
 * @param dailyByCode 基准日 daily 截面，按 ts_code 建索引
 * @param basicByCode 基准日 daily_basic 截面，按 ts_code 建索引
 * @param records 诊断/排除记录累加数组（原地写入）
 * @returns 通过阶段 A 全部截面条件的工作态候选
 */
export function runStageA(
  stocks: StockBasicRow[],
  dailyByCode: Map<string, DailyRow>,
  basicByCode: Map<string, DailyBasicRow>,
  records: ExclusionRecord[]
): WorkingCandidate[] {
  const survivors: WorkingCandidate[] = [];

  for (const stock of stocks) {
    const code = stock.ts_code;

    // 1) 主板 + 代码前缀（需求 1.2–1.4）：非主板直接剔除，不写诊断（属正常范围收敛）
    if (!isMainBoard(stock)) continue;

    const daily = dailyByCode.get(code);
    const basic = basicByCode.get(code);

    // 2) 涨幅 [3,5]（需求 2）
    const pctDec = applyPctChg(daily);
    if (!pctDec.keep) {
      recordExclusion(records, code, "pct-chg", pctDec.reason);
      continue;
    }

    // 3) 量比 ≥ 1（需求 3）
    const vrDec = applyVolumeRatio(basic);
    if (!vrDec.keep) {
      recordExclusion(records, code, "volume-ratio", vrDec.reason);
      continue;
    }

    // 4) 换手率 [5,10]（需求 4）
    const trDec = applyTurnoverRate(basic);
    if (!trDec.keep) {
      recordExclusion(records, code, "turnover-rate", trDec.reason);
      continue;
    }

    // 5) 流通市值 [500000,2000000] 万元（需求 5）
    const cmDec = applyCircMv(basic);
    if (!cmDec.keep) {
      recordExclusion(records, code, "circ-mv", cmDec.reason);
      continue;
    }

    survivors.push({
      ts_code: stock.ts_code,
      name: stock.name,
      daily,
      dailyBasic: basic,
    });
  }

  return survivors;
}

/**
 * 阶段 B：历史序列筛选与分级（需求 6、7）。
 *
 * 对阶段 A 幸存候选，依据其历史 daily 序列（升序、末位为基准日）执行：
 *   - 成交量递增分级（classifyVolume）：取历史 vol 序列
 *   - 均线趋势分级（classifyMaTrend）：取历史 close 序列
 * 任一判定排除即短路并写入诊断记录；两项均通过则组装为最终候选，
 * 携带成交量分级与均线分级两个标注。
 *
 * @param candidates 阶段 A 幸存候选
 * @param historyByCode 候选历史序列（升序），按 ts_code 建索引
 * @param records 诊断/排除记录累加数组（原地写入）
 * @returns 通过阶段 B 的最终候选股票（含分级标注）
 */
export function runStageB(
  candidates: WorkingCandidate[],
  historyByCode: Map<string, DailyRow[]>,
  records: ExclusionRecord[]
): CandidateStock[] {
  const result: CandidateStock[] = [];

  for (const cand of candidates) {
    const history = historyByCode.get(cand.ts_code) ?? [];
    const vols = history.map((r) => r.vol);
    const closes = history.map((r) => r.close);

    // 6) 成交量递增分级（需求 6）
    const volDec = classifyVolume(vols);
    if (!volDec.keep) {
      recordExclusion(records, cand.ts_code, "volume-increasing", volDec.reason);
      continue;
    }

    // 7) 均线趋势分级（需求 7）
    const maDec = classifyMaTrend(closes);
    if (!maDec.keep) {
      recordExclusion(records, cand.ts_code, "ma-trend", maDec.reason);
      continue;
    }

    // 分级标注一定存在（keep:true 分支必携带 grade），此处断言非空
    result.push({
      ts_code: cand.ts_code,
      name: cand.name,
      volumeGrade: volDec.grade!,
      maGrade: maDec.grade!,
    });
  }

  return result;
}
