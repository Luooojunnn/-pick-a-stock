// 每日多条件选股（daily-stock-screening）模块的数据模型与类型定义
// 说明：本文件集中定义 Tushare 原始行、领域模型、筛选决策与错误类型，
// 供 data-source、pipeline、filters、service 等模块共享。

// ===== Tushare 原始行（data-source 层） =====

/** stock_basic 行（含板块判定所需 market） */
export interface StockBasicRow {
  ts_code: string; // 如 "600000.SH"
  name: string;
  market: string; // 板块，如 "主板"/"创业板"/"科创板"/"北交所"
}

/** daily 行（当日截面或历史） */
export interface DailyRow {
  ts_code: string;
  trade_date: string; // YYYYMMDD
  close: number;
  pct_chg: number; // 百分比，如 3.5
  vol: number; // 成交量（手）
}

/** daily_basic 行 */
export interface DailyBasicRow {
  ts_code: string;
  trade_date: string;
  volume_ratio: number; // 量比（>0）
  turnover_rate: number; // 换手率（0–100，%）
  circ_mv: number; // 流通市值（万元）
}

// ===== 领域模型 =====

/** 单项分级标注：理想条件 / 放宽条件（二者互斥） */
export type GradeLabel = "理想条件" | "放宽条件";

/** pipeline 内部流转的工作态候选（可携带尚未定型的分级） */
export interface WorkingCandidate {
  ts_code: string;
  name: string;
  daily?: DailyRow; // 基准日截面
  dailyBasic?: DailyBasicRow; // 基准日截面
  history?: DailyRow[]; // 升序历史序列（阶段 B 填充）
  volumeGrade?: GradeLabel; // 需求 6 分级
  maGrade?: GradeLabel; // 需求 7 分级
}

/** 接口最终返回的候选股票（需求 9.2） */
export interface CandidateStock {
  ts_code: string; // 股票代码
  name: string; // 名称
  volumeGrade: GradeLabel; // 成交量分级："理想条件" | "放宽条件"
  maGrade: GradeLabel; // 均线分级："理想条件" | "放宽条件"
}

/** 接口响应 */
export interface RecommendationResponse {
  code: 0 | -1;
  data?: CandidateStock[]; // 成功时；长度 0..主板股票总数
  message?: string; // 失败时
}

/** 筛选上下文 */
export interface ScreeningContext {
  referenceDay: string; // 基准日 YYYYMMDD
  intradayEnabled: boolean;
}

/** 诊断/排除记录（用于需求 4.4/5.4/6.5 的可查询记录） */
export interface ExclusionRecord {
  ts_code: string;
  filter: string; // 触发排除的筛选名
  reason: string; // 排除原因（缺字段、无效值、数据不足等）
}

// ===== 筛选决策与筛选器接口 =====

/** 筛选决策联合类型：保留（可携带分级）或排除（携带原因） */
export type FilterDecision =
  | { keep: true; grade?: GradeLabel } // 保留，可携带分级标注
  | { keep: false; reason: string }; // 排除，携带原因（用于诊断记录）

/** 筛选器接口：每个 filter 为纯函数 */
export interface Filter {
  name: string;
  apply(stock: WorkingCandidate, ctx: ScreeningContext): FilterDecision;
}

// ===== 错误类型 =====

/** 筛选流程错误：携带失败接口名与错误分类，用于中止整体并返回诊断信息 */
export class ScreeningError extends Error {
  constructor(
    message: string,
    readonly apiName?: string,
    readonly kind?:
      | "permission"
      | "timeout"
      | "empty"
      | "no-reference-day"
      | "generic"
  ) {
    super(message);
    this.name = "ScreeningError";
  }
}
