// I 因子：机构参与度（Institutional Sponsorship）
//
// O'Neil 的观点是双面的：优秀股票需要机构资金推动（散户买不出大行情），
// 但机构持仓过度拥挤反而危险（想卖的时候没有对手盘）。所以这个因子不是「越多越好」，
// 而是「有机构、且趋势在改善、但还没挤满」。
//
// 数据口径与实测结论：
// - top10_floatholders 的 holder_type 实际取值只有「投资公司 / 一般企业 / 自然人 /
//   开放式投资基金 / 其他金融产品 / 风险投资公司」，没有标准的「基金/保险/社保」分类，
//   因此机构识别必须用 holder_type 白名单叠加 holder_name 关键词。
// - 「香港中央结算有限公司」在接口里被归为「一般企业」，但它实际是北向资金通道，
//   必须单独识别——把它当普通企业会丢掉一个重要的资金面信号。
// - hold_change 为 null 表示该股东本期新进（不是「持仓未变」）。
//
// 降级：这两个接口都需要 2000 积分。取数失败或数据为空时整个因子记为 null，
// 权重摊给其余因子，并在响应里说明原因，而不是静默给 0 分——
// 给 0 分会让「没数据」和「机构在撤离」变得无法区分。

import type { Top10FloatHolderRow, HolderNumberRow } from "../data-source";
import type { CanSlimConfig } from "../config";
import type { FactorResult } from "../types";
import { degraded } from "../types";
import type { HolderNumChange } from "./s-supply";

/**
 * holder_type 中可直接判定为机构的取值。
 *
 * 这份清单来自真实数据抽样，而非接口文档——文档并未列出 holder_type 的枚举值。
 * 已观测到的取值包括：投资公司、一般企业、自然人、开放式投资基金、其他金融产品、
 * 风险投资公司、国资局、基金专户理财、券商集合资产管理计划、保险投资组合、
 * 社保基金社保机构等。其中「国资局」与「一般企业」不计入机构：
 * 国资平台属于长期战略持股，不是 O'Neil 所指的「会用脚投票的机构资金」。
 */
const INSTITUTION_TYPES = new Set([
  "开放式投资基金",
  "封闭式投资基金",
  "其他金融产品",
  "投资公司",
  "风险投资公司",
  "基金",
  "基金专户理财",
  "券商集合资产管理计划",
  "保险投资组合",
  "保险公司",
  "社保基金、社保机构",
  "社保基金",
  "社保",
  "信托公司",
  "证券公司",
  "QFII",
  "银行",
  "财务公司",
  "企业年金",
]);

/** holder_name 中出现即判定为机构的关键词（用于 holder_type 分类不足的情况） */
const INSTITUTION_NAME_KEYWORDS = [
  "基金",
  "资产管理",
  "资管",
  "保险",
  "社保",
  "年金",
  "信托",
  "证券",
  "投资管理",
  "养老",
  "QFII",
  "汇金",
  "证金",
  "国新",
  "诚通",
  "私募",
  "创业投资",
  "股权投资",
  "投资局", // 主权基金，如阿布达比投资局
  // 外资机构常以英文名出现在十大股东里，holder_type 往往被归为「一般企业」
  "UBS",
  "NOMINEES",
  "MORGAN",
  "GOLDMAN",
  "CITIGROUP",
  "HSBC",
  "BARCLAYS",
  "MERRILL",
  "VANGUARD",
  "BLACKROCK",
  "INVESTMENT",
  "CAPITAL",
  "ASSET",
  "FUND",
];

/**
 * 北向资金通道的名称标识（接口里被归为「一般企业」，需单独识别）。
 * 含「香港中央结算(代理人)有限公司」及其英文名 HKSCC NOMINEES。
 */
const NORTHBOUND_KEYWORDS = ["香港中央结算", "HKSCC"];

/** 标准季度末报告期的月日后缀 */
const QUARTER_END_SUFFIXES = ["0331", "0630", "0930", "1231"];

/**
 * 判断是否为标准季度末报告期。
 *
 * 十大流通股东数据里会混入非季度末的临时披露（如股份变动、解禁后的更新披露）。
 * 实测宁德时代同时存在 20260630、20260724、20260805 三个「报告期」。
 * 做季度趋势比较时必须只用标准季度末，否则「连续两个季度增加」会退化成
 * 「连续两次临时披露增加」，可能只隔十几天，失去季度趋势的含义。
 */
function isQuarterEnd(endDate: string): boolean {
  return QUARTER_END_SUFFIXES.some((s) => endDate.endsWith(s));
}

/** 单个报告期的机构持仓汇总 */
interface PeriodSummary {
  endDate: string;
  /** 机构股东家数 */
  institutionCount: number;
  /** 机构合计占流通股比例（%） */
  institutionRatio: number;
  /** 北向资金占流通股比例（%）；未出现在十大股东中则为 null */
  northboundRatio: number | null;
  /** 十大流通股东合计占流通股比例（%），用于判断拥挤度 */
  top10Ratio: number;
  /** 本期新进的机构家数 */
  newInstitutions: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 判断某个股东是否为北向资金通道 */
function isNorthbound(holder: Top10FloatHolderRow): boolean {
  return NORTHBOUND_KEYWORDS.some((kw) => holder.holder_name.includes(kw));
}

/** 判断某个股东是否为机构（北向资金单独统计，不计入机构） */
export function isInstitution(holder: Top10FloatHolderRow): boolean {
  if (isNorthbound(holder)) return false;
  if (INSTITUTION_TYPES.has(holder.holder_type)) return true;
  // 英文机构名大小写不固定（如 UBSAG / UBS AG），统一转大写后匹配
  const name = holder.holder_name.toUpperCase();
  return INSTITUTION_NAME_KEYWORDS.some((kw) => name.includes(kw.toUpperCase()));
}

/** 汇总单个报告期的持仓结构 */
function summarizePeriod(endDate: string, holders: Top10FloatHolderRow[]): PeriodSummary {
  let institutionCount = 0;
  let institutionRatio = 0;
  let northboundRatio: number | null = null;
  let top10Ratio = 0;
  let newInstitutions = 0;

  for (const h of holders) {
    // 优先用占流通股比例；缺失时退回占总股本比例
    const ratio = h.hold_float_ratio ?? h.hold_ratio ?? 0;
    top10Ratio += ratio;

    if (isNorthbound(h)) {
      northboundRatio = (northboundRatio ?? 0) + ratio;
      continue;
    }
    if (isInstitution(h)) {
      institutionCount++;
      institutionRatio += ratio;
      // hold_change 为 null 表示本期新进
      if (h.hold_change === null) newInstitutions++;
    }
  }

  return {
    endDate,
    institutionCount,
    institutionRatio,
    northboundRatio,
    top10Ratio,
    newInstitutions,
  };
}

/**
 * 从股东户数序列计算环比变化。
 *
 * 股东户数下降意味着筹码向少数人集中，通常伴随主力吸筹；
 * 上升意味着筹码分散，往往是派发。这个指标同时供 S 因子使用。
 */
export function computeHolderNumChange(rows: HolderNumberRow[]): HolderNumChange | null {
  const valid = rows.filter((r) => r.holder_num !== null && r.holder_num > 0);
  if (valid.length < 2) return null;

  const latest = valid[0]!;
  const previous = valid[1]!;
  const latestNum = latest.holder_num as number;
  const prevNum = previous.holder_num as number;

  return {
    latest: latestNum,
    previous: prevNum,
    changePct: ((latestNum - prevNum) / prevNum) * 100,
    endDate: latest.end_date,
  };
}

/**
 * 计算 I 因子。
 *
 * @param holdersByPeriod end_date -> 十大流通股东列表（由 financials 层按 ann_date 过滤后传入）
 * @param holderNums 股东户数序列（降序），可选
 * @param cfg 生效配置
 */
export function computeInstitutionFactor(
  holdersByPeriod: Map<string, Top10FloatHolderRow[]>,
  holderNums: HolderNumberRow[] | undefined,
  cfg: CanSlimConfig
): FactorResult {
  if (holdersByPeriod.size === 0) {
    return degraded("无可用的前十大流通股东数据（接口未取到或该股无披露）");
  }

  // 只保留标准季度末报告期，并按降序排列（最新在前）。
  // 过滤掉临时披露是为了让「连续两个季度」真的是两个季度，详见 isQuarterEnd 的说明。
  const endDates = [...holdersByPeriod.keys()].filter(isQuarterEnd).sort().reverse();
  if (endDates.length === 0) {
    return degraded("仅有非季度末的临时披露数据，无法做季度趋势比较");
  }
  const summaries = endDates.map((d) => summarizePeriod(d, holdersByPeriod.get(d) ?? []));

  const latest = summaries[0]!;
  const previous = summaries[1];
  const beforePrevious = summaries[2];

  const { holderCountGrowthMin, crowdedRatioMax } = cfg.i;

  // ===== 子项评分 =====
  let score = 30; // 基准分：有机构披露数据即给底座
  const details: string[] = [];

  details.push(
    `最新报告期 ${formatPeriod(latest.endDate)}：十大流通股东中机构 ${latest.institutionCount} 家，` +
      `合计持流通股 ${latest.institutionRatio.toFixed(2)}%`
  );

  // 1. 机构家数变化
  let countScore = 0;
  if (previous) {
    const countDelta = latest.institutionCount - previous.institutionCount;
    if (countDelta >= holderCountGrowthMin) {
      countScore = clamp(15 + countDelta * 5, 15, 25);
      details.push(
        `机构家数增加 ${countDelta} 家（${previous.institutionCount} → ${latest.institutionCount}）`
      );
    } else if (countDelta === 0) {
      countScore = 10;
      details.push(`机构家数持平（${latest.institutionCount} 家）`);
    } else {
      countScore = 0;
      details.push(
        `机构家数减少 ${Math.abs(countDelta)} 家（${previous.institutionCount} → ${latest.institutionCount}）`
      );
    }
  } else {
    countScore = 8;
    details.push("仅有一个报告期数据，无法比较机构家数变化");
  }

  // 2. 机构持股比例变化
  let ratioScore = 0;
  if (previous) {
    const ratioDelta = latest.institutionRatio - previous.institutionRatio;
    if (ratioDelta > 0.5) {
      ratioScore = clamp(15 + ratioDelta * 2, 15, 25);
      details.push(
        `机构持股比例上升 ${ratioDelta.toFixed(2)} 个百分点（${previous.institutionRatio.toFixed(2)}% → ${latest.institutionRatio.toFixed(2)}%）`
      );
    } else if (ratioDelta >= -0.5) {
      ratioScore = 10;
      details.push(`机构持股比例基本持平（${ratioDelta >= 0 ? "+" : ""}${ratioDelta.toFixed(2)} 个百分点）`);
    } else {
      ratioScore = 0;
      details.push(
        `机构持股比例下降 ${Math.abs(ratioDelta).toFixed(2)} 个百分点（${previous.institutionRatio.toFixed(2)}% → ${latest.institutionRatio.toFixed(2)}%）`
      );
    }
  } else {
    ratioScore = 8;
  }

  // 3. 连续两个季度增加（规格明确的加分项）
  let consecutiveScore = 0;
  if (previous && beforePrevious) {
    const risingCount =
      latest.institutionCount > previous.institutionCount &&
      previous.institutionCount > beforePrevious.institutionCount;
    const risingRatio =
      latest.institutionRatio > previous.institutionRatio &&
      previous.institutionRatio > beforePrevious.institutionRatio;

    if (risingCount || risingRatio) {
      consecutiveScore = 20;
      details.push(
        `机构${risingRatio ? "持股比例" : "家数"}连续两个报告期增加` +
          `（${formatPeriod(beforePrevious.endDate)} → ${formatPeriod(previous.endDate)} → ${formatPeriod(latest.endDate)}）`
      );
    }
  }

  // 4. 新进机构
  let newScore = 0;
  if (latest.newInstitutions > 0) {
    newScore = clamp(latest.newInstitutions * 4, 0, 12);
    details.push(`本期有 ${latest.newInstitutions} 家机构新进十大流通股东`);
  }

  // 5. 北向资金（A 股特有的重要资金面信号）
  let northboundScore = 0;
  if (latest.northboundRatio !== null) {
    const prevNorth = previous?.northboundRatio ?? null;
    if (prevNorth !== null) {
      const delta = latest.northboundRatio - prevNorth;
      if (delta > 0.1) {
        northboundScore = 10;
        details.push(
          `北向资金增持，持流通股比例 ${prevNorth.toFixed(2)}% → ${latest.northboundRatio.toFixed(2)}%`
        );
      } else if (delta < -0.1) {
        northboundScore = 0;
        details.push(
          `北向资金减持，持流通股比例 ${prevNorth.toFixed(2)}% → ${latest.northboundRatio.toFixed(2)}%`
        );
      } else {
        northboundScore = 5;
        details.push(`北向资金持流通股 ${latest.northboundRatio.toFixed(2)}%，基本持平`);
      }
    } else {
      northboundScore = 7;
      details.push(`北向资金新进，持流通股 ${latest.northboundRatio.toFixed(2)}%`);
    }
  }

  score += countScore + ratioScore + consecutiveScore + newScore + northboundScore;

  // ===== 惩罚：持仓过度拥挤 =====
  const penalties: string[] = [];
  if (latest.top10Ratio > crowdedRatioMax) {
    score -= 10;
    penalties.push(
      `十大流通股东合计持股 ${latest.top10Ratio.toFixed(1)}%，超过 ${crowdedRatioMax}%，筹码过度集中、流动性风险偏高`
    );
  }
  // 完全没有机构参与：CAN SLIM 明确不喜欢无机构背书的股票
  if (latest.institutionCount === 0 && latest.northboundRatio === null) {
    score -= 15;
    penalties.push("十大流通股东中无机构与北向资金参与");
  }

  // ===== 股东户数（作为机构行为的辅助印证） =====
  const holderChange = holderNums ? computeHolderNumChange(holderNums) : null;
  if (holderChange) {
    if (holderChange.changePct <= -cfg.s.holderNumDropPct) {
      score += 5;
      details.push(
        `股东户数环比减少 ${Math.abs(holderChange.changePct).toFixed(1)}%（${holderChange.previous} → ${holderChange.latest}），筹码集中`
      );
    } else if (holderChange.changePct >= cfg.s.holderNumDropPct) {
      details.push(
        `股东户数环比增加 ${holderChange.changePct.toFixed(1)}%（${holderChange.previous} → ${holderChange.latest}），筹码分散`
      );
    }
  }

  if (penalties.length > 0) {
    details.push(`⚠️ 扣分项：${penalties.join("；")}`);
  }

  score = clamp(score, 0, 100);

  return {
    score,
    details,
    metrics: {
      latestPeriod: latest.endDate,
      institutionCount: latest.institutionCount,
      institutionRatio: Math.round(latest.institutionRatio * 100) / 100,
      previousInstitutionCount: previous?.institutionCount ?? null,
      previousInstitutionRatio:
        previous === undefined ? null : Math.round(previous.institutionRatio * 100) / 100,
      northboundRatio:
        latest.northboundRatio === null ? null : Math.round(latest.northboundRatio * 100) / 100,
      top10Ratio: Math.round(latest.top10Ratio * 100) / 100,
      newInstitutions: latest.newInstitutions,
      periodsAvailable: summaries.length,
      holderNumChangePct:
        holderChange === null ? null : Math.round(holderChange.changePct * 100) / 100,
      countScore,
      ratioScore,
      consecutiveScore,
      northboundScore,
    },
  };
}

/** 20260630 → 2026Q2 */
function formatPeriod(endDate: string): string {
  const y = endDate.slice(0, 4);
  const md = endDate.slice(4);
  const q =
    md === "0331" ? "Q1" : md === "0630" ? "Q2" : md === "0930" ? "Q3" : md === "1231" ? "Q4" : md;
  return `${y}${q}`;
}
