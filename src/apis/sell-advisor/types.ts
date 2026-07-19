// 卖出策略服务（how-to-sell / "我的股票合适卖"）模块的数据模型与类型定义
// 说明：本文件集中定义 Tushare 原始行、输入模型、中间快照、输出模型与错误类型，
// 供 data-source、validation、code、indicators、strategy/*、service 等模块共享。
// 严格对照 design.md 的 "Data Models" 章节实现。

// ===== Tushare 原始行（data-source 层） =====

/** daily / pro_bar 单日行情（需求 2.1、Glossary Daily_Bar） */
export interface DailyBar {
  ts_code: string;
  trade_date: string; // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number; // 成交量（手）
}

// ===== 输入模型 =====

/** 前端提交的原始持仓输入（未校验） */
export interface PositionInputRaw {
  code: string; // 6 位纯数字
  cost: number | string;
  position: number | string;
  buy_date?: string; // 可选 YYYYMMDD
}

/** 校验并规范化后的持仓输入（需求 1） */
export interface NormalizedInput {
  code: string; // 6 位数字
  full_code: string; // 补全后带后缀，如 600000.SH / 000001.SZ
  cost: number; // 0.01–999999.99，≤2 位小数
  position: number; // 1–9999999999 整数
  buy_date?: string; // 合法 YYYYMMDD
}

// ===== 中间快照 =====

/** 最近交易日的均线快照（需求 5.1） */
export interface MASnapshot {
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
}

/** 单档分批止盈目标（需求 7.2） */
export interface TakeProfitTarget {
  price: number; // 保留 2 位小数，>0
  ratio: number; // 0–1
  reason: string;
  reached: boolean; // current_price ≥ price（需求 7.4）
}

/** 单维度得分明细（需求 9.7、11.2） */
export interface DimensionScore {
  name: "趋势" | "价格" | "成交量" | "资金" | "风险";
  score: number; // 该维度得分
  max: number; // 该维度满分（30/20/20/20/10）
  note?: string; // 如"风险维度不可计算"（需求 9.9）
}

// ===== 输出模型（需求 11.2） =====

/** 综合卖出建议（需求 10、11.3） */
export type Suggestion = "卖出" | "持有" | "继续观察" | "减仓";

/** 趋势状态（需求 5.6） */
export type TrendState = "强势" | "转坏" | "中性" | "数据不足";

/** 卖出建议结构（Sell_Advice_API 成功响应的 data） */
export interface SellAdvice {
  // 盈亏（需求 3）
  current_price: number;
  cost: number;
  profit_pct: number;
  // 成本止损（需求 4）
  fixed_stop_loss: number | null;
  atr_stop_loss: number | null;
  stop_loss: number | null;
  cost_stop_triggered: boolean;
  // 趋势（需求 5）
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  trend: TrendState;
  reduce_half: boolean;
  // 移动止盈（需求 6、8）
  highest_price: number | null;
  trailing_stop: number | null;
  trailing_triggered: boolean;
  retreat_ratio: number; // 最终生效回撤比例
  volume_divergence: boolean; // 量价背离（需求 8.2）
  volume_confirm_executed: boolean; // 成交量确认是否执行（需求 8.4）
  // 分批止盈（需求 7）
  take_profit: TakeProfitTarget[]; // 长度 ≤ 2
  // 评分与建议（需求 9、10）
  health_score: number; // 0–100 整数
  dimensions: DimensionScore[]; // 五维度明细
  suggestion: Suggestion;
}

// ===== 错误类型 =====

/** 输入校验错误 → HTTP 400（需求 11.5） */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 计算/接口错误 → HTTP 500（需求 2.5、2.6、11.6） */
export class SellAdvisorError extends Error {
  constructor(
    message: string,
    readonly apiName?: string,
    readonly kind?: "timeout" | "permission" | "insufficient-data" | "generic"
  ) {
    super(message);
    this.name = "SellAdvisorError";
  }
}
