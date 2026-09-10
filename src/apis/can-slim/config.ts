// CAN SLIM 参数配置（config.ts）
//
// 规格要求「所有阈值可配置，不能大量 magic number」。这里集中定义全部阈值，
// 因子层只读取本模块，不内嵌数字。
//
// 重要定位：这些数字是**初始假设**，不是经过 A 股回测验证的最优参数。
// O'Neil 的原始标准（季度 EPS +25%、ROE 17%、RS 80+）来自美股长周期统计，
// A 股的行业结构、涨跌停制度、财报披露节奏都不同，参数需要回测后再调。

/** 因子权重（M 不占权重，作为市场开关单独处理） */
export interface FactorWeights {
  c: number;
  a: number;
  n: number;
  s: number;
  l: number;
  i: number;
}

/** 市场环境三态 */
export type MarketRegime = "BULL" | "NEUTRAL" | "BEAR";

export interface CanSlimConfig {
  /** 因子权重，合计应为 1；某因子降级时其权重按比例摊给其余因子 */
  weights: FactorWeights;

  /** C —— 当季盈利 */
  c: {
    /** 单季扣非净利同比下限（%），硬门槛 */
    quarterlyProfitYoyMin: number;
    /** 单季营收同比下限（%），硬门槛 */
    quarterlySalesYoyMin: number;
    /** EPS 同比达此值加满分（%） */
    epsYoyStrong: number;
    /** 扣非净利同比达此值加分（%） */
    profitYoyStrong: number;
    /** 营收同比达此值加分（%） */
    salesYoyStrong: number;
    /** 连续加速的最少季度数 */
    accelerationQuarters: number;
  };

  /** A —— 年度盈利 */
  a: {
    /** 3 年 EPS 复合增长下限（%），硬门槛 */
    epsCagrMin: number;
    /** 3 年 EPS 复合增长优秀线（%） */
    epsCagrStrong: number;
    /** ROE 合格线（%） */
    roeMin: number;
    /** ROE 优秀线（%），O'Neil 原始标准 17% */
    roeStrong: number;
    /** 计算 CAGR 所需的年报数 */
    cagrYears: number;
  };

  /** N —— 新高与突破 */
  n: {
    /** 距 52 周高点的比例，达此值视为「贴近新高」（0.95 表示价格 ≥ 高点 × 95%） */
    near52wHighStrong: number;
    /** 距 52 周高点的比例，达此值视为「高位」 */
    near52wHighOk: number;
    /** 低于此比例视为「远离新高」 */
    far52wHighPenalty: number;
    /**
     * 距高点比例映射为分数时的下界：ratio ≤ nearHighFloor 记 0 分，ratio = 1 记 100 分。
     * 取 0.6 是因为跌超 40% 的股票在 CAN SLIM 语境下已不具备领导地位，再细分无意义。
     */
    nearHighFloor: number;
    /** 突破判定所用的历史窗口（交易日），需升序 */
    breakoutLookbacks: number[];
    /** 各窗口突破对应的分值，与 breakoutLookbacks 一一对应 */
    breakoutScores: number[];
    /** 未发生突破但仍在高位时的基准突破分 */
    noBreakoutScore: number;
    /** 突破当日成交量需达均量的倍数 */
    breakoutVolumeRatio: number;
    /** 缩量突破的分数折扣（0.6 表示只给 60%） */
    weakVolumeDiscount: number;
    /** N 得分中「距高点」与「突破」的配比，合计应为 1 */
    nearHighWeight: number;
    breakoutWeight: number;
    /** 创出 52 周新高的额外加分 */
    new52wHighBonus: number;
    /** 52 周对应的交易日数 */
    yearTradingDays: number;
  };

  /** S —— 供需 */
  s: {
    /** 均量周期（交易日） */
    volumeMaDays: number;
    /** 「上涨放量」的量能倍数 */
    surgeVolumeRatio: number;
    /** 换手率合理区间（%，自由流通口径）：过低无人关注，过高过热 */
    turnoverMin: number;
    turnoverMax: number;
    /** 换手率最佳区间（该区间内给满分） */
    turnoverSweetMin: number;
    turnoverSweetMax: number;
    /** 量比合格线 */
    volumeRatioMin: number;
    /** 量比优秀线 */
    volumeRatioStrong: number;
    /** 股东人数环比下降视为筹码集中的阈值（%） */
    holderNumDropPct: number;
    /**
     * 流通市值偏好分档（单位：万元）。
     * CAN SLIM 原意是「供给少的股票更容易被推动」，A 股同样如此：
     * 超大盘股需要天量资金才能形成趋势，微盘股则有流动性与操纵风险。
     */
    circMvTiers: { maxCircMv: number; score: number; label: string }[];
    /** 各子项权重，合计应为 1；股东人数不可用时其权重摊给其余子项 */
    subWeights: {
      priceVolume: number;
      turnover: number;
      volumeRatio: number;
      circMv: number;
      holderNum: number;
    };
  };

  /** L —— 领导地位 */
  l: {
    /** RS 各回看周期（交易日）与权重，权重合计应为 1 */
    rsLookbacks: { days: number; weight: number }[];
    /** RS 硬门槛（1–99 百分位） */
    rsMin: number;
    /** RS 评分档位 */
    rsStrong: number;
    rsGood: number;
    rsWeak: number;
    /** 行业强度进入前多少比例视为强势行业（0.2 = 前 20%） */
    industryTopRatio: number;
    /** 计算 RS 所需的最少交易日数，不足则 L 因子降级 */
    minTradingDays: number;
    /**
     * L 得分中「个股 RS」与「行业强度分位」的配比，两者合计应为 1。
     * 用加权混合而非直接加减分，是为了避免强势股大量饱和在 100 分、丢失区分度。
     */
    rsWeightInScore: number;
    industryWeightInScore: number;
  };

  /** I —— 机构持仓 */
  i: {
    /** 机构股东家数增加的加分门槛 */
    holderCountGrowthMin: number;
    /** 机构持股比例被视为「极度拥挤」的上限（%），超过则小幅扣分 */
    crowdedRatioMax: number;
  };

  /** M —— 市场环境 */
  m: {
    /** 参与判定的指数 */
    indexes: { ts_code: string; name: string }[];
    /** 短期均线周期 */
    maShort: number;
    /** 长期均线周期 */
    maLong: number;
    /** 两条均线相对差异小于此比例视为「纠缠」，判为 Neutral */
    maConvergenceThreshold: number;
    /** 单指数三态对应分值 */
    regimeScores: { bull: number; neutral: number; bear: number };
    /** 市场综合分对应整体三态的下限 */
    bullThreshold: number;
    neutralThreshold: number;
  };

  /** 选股与买入信号 */
  screen: {
    /** 不同市场环境下的入选总分门槛 */
    scoreThreshold: Record<MarketRegime, number>;
    /** 最多返回多少只候选 */
    topN: number;
    /** 是否排除 ST/*ST */
    excludeSt: boolean;
    /** 是否排除北交所（流动性与制度差异较大） */
    excludeBse: boolean;
    /** 上市不足多少交易日直接排除（连 52 周数据都没有） */
    minListedDays: number;
    /**
     * 进入财务层（在线逐只拉 fina_indicator）的最大候选数。
     *
     * 财务接口只能按单只股票取数，是整条流水线唯一的高成本环节。
     * 因此先用零成本的本地技术面因子（L/N/S）排序收缩，再对前若干名拉财务。
     * CAN SLIM 要求 N 与 S 同样达标，用它们预筛不会丢掉真正符合条件的标的。
     */
    maxFinancialFetch: number;
    /** 进入机构层（在线逐只拉 top10_floatholders）的最大候选数 */
    maxInstitutionFetch: number;
    /** 技术面预筛排序时 L/N/S 的配比，合计应为 1 */
    preScreenWeights: { l: number; n: number; s: number };
  };

  /** 风险控制 */
  risk: {
    /** 初始止损比例（0.08 = 买入价下方 8%） */
    stopLossPct: number;
    /** 移动止盈回撤比例 */
    trailingStopPct: number;
  };
}

/** 默认配置 */
export const DEFAULT_CONFIG: CanSlimConfig = {
  weights: {
    c: 0.2,
    a: 0.15,
    n: 0.15,
    s: 0.1,
    l: 0.25,
    i: 0.15,
  },

  c: {
    quarterlyProfitYoyMin: 25,
    quarterlySalesYoyMin: 15,
    epsYoyStrong: 25,
    profitYoyStrong: 25,
    salesYoyStrong: 20,
    accelerationQuarters: 2,
  },

  a: {
    epsCagrMin: 15,
    epsCagrStrong: 25,
    roeMin: 15,
    roeStrong: 17,
    cagrYears: 3,
  },

  n: {
    near52wHighStrong: 0.95,
    near52wHighOk: 0.9,
    far52wHighPenalty: 0.8,
    nearHighFloor: 0.6,
    breakoutLookbacks: [20, 50, 120],
    breakoutScores: [60, 80, 100],
    noBreakoutScore: 30,
    breakoutVolumeRatio: 1.4,
    weakVolumeDiscount: 0.6,
    nearHighWeight: 0.75,
    breakoutWeight: 0.25,
    new52wHighBonus: 5,
    yearTradingDays: 250,
  },

  s: {
    volumeMaDays: 20,
    surgeVolumeRatio: 1.5,
    turnoverMin: 0.5,
    turnoverMax: 30,
    turnoverSweetMin: 3,
    turnoverSweetMax: 15,
    volumeRatioMin: 1,
    volumeRatioStrong: 1.5,
    holderNumDropPct: 5,
    // 单位万元：30 亿 = 300000，500 亿 = 5000000，2000 亿 = 20000000
    circMvTiers: [
      { maxCircMv: 300000, score: 55, label: "微盘（流通市值 < 30 亿）流动性偏弱" },
      { maxCircMv: 5000000, score: 100, label: "中小盘（30 亿 ~ 500 亿）供给适中" },
      { maxCircMv: 20000000, score: 70, label: "大盘（500 亿 ~ 2000 亿）" },
      { maxCircMv: Number.MAX_SAFE_INTEGER, score: 45, label: "超大盘（> 2000 亿）推动成本高" },
    ],
    subWeights: {
      priceVolume: 0.4,
      turnover: 0.2,
      volumeRatio: 0.15,
      circMv: 0.15,
      holderNum: 0.1,
    },
  },

  l: {
    // 规格给定的 IBD 近似口径：长周期权重更高，兼顾近期动能
    rsLookbacks: [
      { days: 250, weight: 0.3 },
      { days: 120, weight: 0.3 },
      { days: 60, weight: 0.25 },
      { days: 20, weight: 0.15 },
    ],
    rsMin: 70,
    rsStrong: 90,
    rsGood: 80,
    rsWeak: 50,
    industryTopRatio: 0.2,
    minTradingDays: 250,
    rsWeightInScore: 0.85,
    industryWeightInScore: 0.15,
  },

  i: {
    holderCountGrowthMin: 1,
    crowdedRatioMax: 80,
  },

  m: {
    indexes: [
      { ts_code: "000001.SH", name: "上证指数" },
      { ts_code: "399001.SZ", name: "深证成指" },
      { ts_code: "000300.SH", name: "沪深300" },
      { ts_code: "399006.SZ", name: "创业板指" },
    ],
    maShort: 50,
    maLong: 200,
    maConvergenceThreshold: 0.02,
    regimeScores: { bull: 100, neutral: 60, bear: 20 },
    bullThreshold: 80,
    neutralThreshold: 45,
  },

  screen: {
    // 熊市门槛设为 101（不可达），等价于「不产生买入信号，只输出观察列表」
    scoreThreshold: { BULL: 75, NEUTRAL: 85, BEAR: 101 },
    topN: 50,
    excludeSt: true,
    excludeBse: true,
    minListedDays: 250,
    maxFinancialFetch: 400,
    maxInstitutionFetch: 120,
    preScreenWeights: { l: 0.5, n: 0.3, s: 0.2 },
  },

  risk: {
    stopLossPct: 0.08,
    trailingStopPct: 0.1,
  },
};

/**
 * 合并用户覆盖项，生成生效配置。
 * 只做一层深合并，够用且行为可预期。
 */
export function resolveConfig(overrides?: Partial<CanSlimConfig>): CanSlimConfig {
  if (!overrides) return DEFAULT_CONFIG;
  return {
    weights: { ...DEFAULT_CONFIG.weights, ...overrides.weights },
    c: { ...DEFAULT_CONFIG.c, ...overrides.c },
    a: { ...DEFAULT_CONFIG.a, ...overrides.a },
    n: { ...DEFAULT_CONFIG.n, ...overrides.n },
    s: { ...DEFAULT_CONFIG.s, ...overrides.s },
    l: { ...DEFAULT_CONFIG.l, ...overrides.l },
    i: { ...DEFAULT_CONFIG.i, ...overrides.i },
    m: { ...DEFAULT_CONFIG.m, ...overrides.m },
    screen: { ...DEFAULT_CONFIG.screen, ...overrides.screen },
    risk: { ...DEFAULT_CONFIG.risk, ...overrides.risk },
  };
}
