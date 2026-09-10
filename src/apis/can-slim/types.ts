// CAN SLIM 选股模块的数据模型与类型定义
//
// 分层约定：
// - 「Tushare 原始行」：data-source 层从接口取回、原样落入本地库的形状。
// - 「领域模型」：因子层与评分层使用的结构，不含任何接口细节。
//
// 本文件随任务推进增量扩充：Task 1/2 只需行情与同步相关类型，
// 因子结果与评分结构在后续任务加入。

// ===== Tushare 原始行 =====

/** stock_basic 行 */
export interface StockBasicRow {
  ts_code: string; // 如 "600519.SH"
  name: string;
  industry: string; // 行业（用于 L 因子行业强度分组）
  market: string; // 主板 / 创业板 / 科创板 / 北交所
  list_date: string; // 上市日期 YYYYMMDD（用于「上市不足 250 交易日」降级判定）
}

/** daily 行（不复权行情；停牌日接口不提供数据，故本地库同样缺行） */
export interface DailyRow {
  ts_code: string;
  trade_date: string; // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  pct_chg: number; // 涨跌幅（%）
  vol: number; // 成交量（手）
  amount: number; // 成交额（千元）
}

/** adj_factor 行（复权因子，用于把不复权价换算为可比的复权价） */
export interface AdjFactorRow {
  ts_code: string;
  trade_date: string;
  adj_factor: number;
}

/** daily_basic 行（每日基本面指标截面） */
export interface DailyBasicRow {
  ts_code: string;
  trade_date: string;
  close: number;
  turnover_rate: number; // 换手率（%，无限售流通股口径）
  turnover_rate_f: number; // 换手率（%，自由流通股口径，S 因子优先使用）
  volume_ratio: number; // 量比
  float_share: number; // 流通股本（万股）
  free_share: number; // 自由流通股本（万股）
  circ_mv: number; // 流通市值（万元）
  total_mv: number; // 总市值（万元）
  /**
   * 收盘涨跌状态：0-平盘，1-上涨(不含涨停)，2-涨停(不含一字涨停)，
   * 3-一字涨停，4-下跌(不含跌停)，5-跌停(不含一字跌停)，6-一字跌停。
   * 用于「基准日已涨停，次日可能无法按参考价买入」提示。
   */
  limit_status: number | null;
}

/** index_daily 行（指数日线，用于 M 因子市场环境判定） */
export interface IndexDailyRow {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pct_chg: number;
  vol: number;
  amount: number;
}

/** trade_cal 行（交易日历） */
export interface TradeCalRow {
  exchange: string;
  cal_date: string; // YYYYMMDD
  is_open: number; // 1 开市 / 0 休市
  pretrade_date: string | null; // 上一交易日
}

// ===== 同步相关 =====

/** 本地库中按交易日记录的同步进度（用于断点续跑） */
export interface SyncProgressRow {
  trade_date: string;
  table_name: string;
  rows: number;
  done_at: string; // ISO 时间串
}

/** 单个交易日的同步结果 */
export interface DaySyncResult {
  tradeDate: string;
  daily: number; // 写入行数
  adjFactor: number;
  dailyBasic: number;
  skipped: boolean; // 是否因已同步而跳过
}

// ===== 错误类型 =====

/**
 * CAN SLIM 流程错误：携带失败接口名与错误分类。
 *
 * kind 语义：
 * - permission：接口权限/积分不足，不重试，触发对应因子降级或整体中止
 * - timeout：单次调用超时（属瞬时错误，可重试）
 * - rate-limit：触发频率限制（可退避重试）
 * - empty：接口返回空结果且该场景下视为异常
 * - db：本地库读写失败
 * - generic：其它
 */
export class CanSlimError extends Error {
  constructor(
    message: string,
    readonly apiName?: string,
    readonly kind?:
      | "permission"
      | "timeout"
      | "rate-limit"
      | "empty"
      | "db"
      | "generic"
  ) {
    super(message);
    this.name = "CanSlimError";
  }
}

// ===== 因子结果 =====

/**
 * 单个因子的计算结果。
 *
 * score 为 null 表示该因子「降级」：数据缺失、接口无权限或历史不足，
 * 此时它不参与总分，权重按比例摊给其余因子，并通过 degradedReason 告知用户。
 * 这是需求确认的第 3 条：能力降级而非静默出错，也不整体中止。
 */
export interface FactorResult {
  /** 0–100 的因子得分；null 表示降级 */
  score: number | null;
  /** 可解释明细：每条是一句人话，直接呈现给用户 */
  details: string[];
  /** 降级原因；score 为 null 时必填 */
  degradedReason?: string;
  /** 结构化指标，便于前端做二次展示或后续回测分析 */
  metrics?: Record<string, number | string | null>;
}

/** 构造一个降级的因子结果 */
export function degraded(reason: string): FactorResult {
  return { score: null, details: [], degradedReason: reason };
}

/** 市场环境判定结果（M 因子） */
export interface MarketRegimeResult {
  regime: "BULL" | "NEUTRAL" | "BEAR";
  /** 市场综合分（0–100） */
  score: number;
  /** 各指数的判定明细 */
  indexes: {
    ts_code: string;
    name: string;
    close: number;
    maShort: number | null;
    maLong: number | null;
    regime: "BULL" | "NEUTRAL" | "BEAR";
    /** 该指数距区间最高点的比例（1 表示正处于新高） */
    nearHighRatio: number | null;
    note: string;
  }[];
  /** 面向用户的一句话结论 */
  summary: string;
  /** 数据不足时的降级说明 */
  degradedReason?: string;
}

// ===== 综合评分与候选股 =====

/** 六因子结果集合（M 不在其中，它是市场开关） */
export interface FactorSet {
  c: FactorResult;
  a: FactorResult;
  n: FactorResult;
  s: FactorResult;
  l: FactorResult;
  i: FactorResult;
}

/** 因子键 */
export type FactorKey = keyof FactorSet;

/** 硬门槛通过情况 */
export interface GateResult {
  /** 各门槛是否通过 */
  passed: Record<string, boolean>;
  /** 未通过的门槛说明 */
  failedReasons: string[];
  /** 是否全部通过 */
  allPassed: boolean;
}

/** 买入信号 */
export interface BuySignal {
  /** 参考买入价（基准日收盘价，不复权） */
  entryPrice: number;
  /** 初始止损价 */
  stopLossPrice: number;
  /** 止损比例 */
  stopLossPct: number;
  /** 触发依据 */
  reasons: string[];
  /** 执行层面的风险提示（如基准日涨停、次日可能买不到） */
  warnings: string[];
}

/** 一只候选股的完整评分结果 */
export interface CanSlimCandidate {
  rank: number;
  ts_code: string;
  name: string;
  industry: string;
  market: string;
  /** 基准日收盘价（不复权，用于展示与止损计算） */
  close: number;
  /** 基准日涨跌幅（%） */
  pctChg: number;
  /** CAN SLIM 综合总分（0–100） */
  totalScore: number;
  /** 六因子明细 */
  factors: FactorSet;
  /** 降级的因子键及原因 */
  degradedFactors: { factor: FactorKey; reason: string }[];
  /** 实际生效的权重（降级归一化后） */
  effectiveWeights: Record<FactorKey, number>;
  /** 硬门槛结果 */
  gates: GateResult;
  /** 买入信号；未触发时为 null */
  buySignal: BuySignal | null;
}

/** 选股流程的诊断统计 */
export interface ScreeningStats {
  /** 全市场股票总数 */
  totalStocks: number;
  /** 构造股票池后剩余 */
  universeSize: number;
  /** 各阶段剩余数量 */
  afterRsGate: number;
  afterFinancialGate: number;
  /** 最终返回的候选数 */
  candidates: number;
  /** 触发买入信号的数量 */
  buySignals: number;
  /** 在线接口调用统计 */
  dataFetch: {
    finaIndicator: { fetched: number; cached: number; failed: number };
    top10Holders: { fetched: number; cached: number; failed: number };
    holderNumbers: { fetched: number; cached: number; failed: number };
  };
  /** 各因子的降级数量 */
  degradedCounts: Record<string, number>;
}

/** 选股接口的完整返回结构 */
export interface CanSlimScreeningResult {
  /** 基准日 */
  asOfDate: string;
  /** 市场环境（M 因子） */
  market: MarketRegimeResult;
  /** 当前市场环境对应的入选总分门槛 */
  scoreThreshold: number;
  /** 候选股列表（按总分降序） */
  candidates: CanSlimCandidate[];
  /** 行业强度排行 */
  industries: { industry: string; medianRs: number; percentile: number; count: number }[];
  /** 诊断统计 */
  stats: ScreeningStats;
  /** 全局降级提示（如某因子整体不可用） */
  warnings: string[];
}
