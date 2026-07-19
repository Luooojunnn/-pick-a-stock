// 综合卖出建议决策（第八步 / 收口层）
// 纯函数模块，无 I/O，便于单元测试与基于属性的测试（PBT）。
// 严格对照 design.md "Components and Interfaces" 第 6 节与 requirements.md 需求 10 实现。

import { SellAdvisorError, type Suggestion } from "../types";

/**
 * decideSuggestion 的入参上下文（需求 10.1）。
 *
 * 说明：
 * - `stop_loss` / `trailing_stop` 允许为 null，表示该止损/止盈线不可用（例如持有期无有效收盘价、
 *   或 cost 无效导致止损不可算）。此时对应的触发判定一律视为「未触发」，而非报错。
 * - 触发标记既可由本函数依据价格比较得出，也可由上游直接传入 `cost_stop_triggered` /
 *   `trailing_triggered`（若传入则以传入值为准，跳过价格比较）。
 */
export interface SuggestionContext {
  /** 当前价（最近有效交易日收盘价），须为有效数值（需求 10.8） */
  current_price: number;
  /** 推荐止损位；null 表示不可用（对应触发判定视为未触发） */
  stop_loss: number | null;
  /** 移动止盈线；null 表示不可用（对应触发判定视为未触发） */
  trailing_stop: number | null;
  /** 健康评分，须为 0..100 的数值（需求 10.1、10.8） */
  health_score: number;
  /** 趋势转坏触发的减仓 50% 标记（需求 5.3、10.7） */
  reduce_half: boolean;
  /** 可选：直接传入的成本止损触发标记；提供时优先于价格比较（需求 4.6） */
  cost_stop_triggered?: boolean;
  /** 可选：直接传入的移动止盈触发标记；提供时优先于价格比较（需求 6.5） */
  trailing_triggered?: boolean;
}

/** 判断入参是否为有效（有限）数值 */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * 综合各层策略得出最终卖出建议（需求 10）。
 *
 * 决策规则与优先级：
 * 1. 防御分支（需求 10.8）：`current_price` 或 `health_score` 缺失/非数值，
 *    或 `health_score` 越出 0..100 范围，或 `stop_loss` / `trailing_stop` 为「非 null 的非法值」时，
 *    抛 `SellAdvisorError`（数据不可用）。注意：`stop_loss` / `trailing_stop` 为 null 属合法（不可用），
 *    不报错，仅将对应触发判定视为未触发。
 * 2. 最高优先级（需求 10.1、10.2）：成本止损触发（current_price ≤ stop_loss）
 *    或移动止盈触发（current_price ≤ trailing_stop）→ "卖出"，优先于评分档位。
 * 3. 否则按 health_score 档位映射（需求 10.3–10.6）：
 *    [80,100]→"持有"、[60,80)→"继续观察"、[40,60)→"减仓"、[0,40)→"卖出"。
 * 4. 未触发止损/止盈且 `reduce_half=true` 且档位结果为"持有"或"继续观察"时，
 *    下调为"减仓"（需求 10.7）。
 *
 * @param ctx 决策上下文
 * @returns 最终卖出建议，取值必属于 {"卖出","持有","继续观察","减仓"}
 */
export function decideSuggestion(ctx: SuggestionContext): Suggestion {
  const {
    current_price,
    stop_loss,
    trailing_stop,
    health_score,
    reduce_half,
    cost_stop_triggered,
    trailing_triggered,
  } = ctx;

  // —— 防御分支（需求 10.8）——
  // current_price 必须为有效数值
  if (!isFiniteNumber(current_price)) {
    throw new SellAdvisorError("综合建议输入数据不可用：current_price 缺失或非数值");
  }
  // health_score 必须为有效数值且落在 0..100 范围内
  if (!isFiniteNumber(health_score) || health_score < 0 || health_score > 100) {
    throw new SellAdvisorError("综合建议输入数据不可用：health_score 缺失、非数值或越界");
  }
  // stop_loss / trailing_stop 允许为 null（不可用）；若非 null 则必须为有效数值，否则视为非法输入
  if (stop_loss !== null && !isFiniteNumber(stop_loss)) {
    throw new SellAdvisorError("综合建议输入数据不可用：stop_loss 非数值");
  }
  if (trailing_stop !== null && !isFiniteNumber(trailing_stop)) {
    throw new SellAdvisorError("综合建议输入数据不可用：trailing_stop 非数值");
  }

  // —— 触发标记推导 ——
  // 优先采用上游直接传入的触发标记；否则依据价格比较得出（null 止损/止盈视为未触发）
  const costTriggered =
    typeof cost_stop_triggered === "boolean"
      ? cost_stop_triggered
      : stop_loss !== null && current_price <= stop_loss;
  const trailingTriggered =
    typeof trailing_triggered === "boolean"
      ? trailing_triggered
      : trailing_stop !== null && current_price <= trailing_stop;

  // —— 最高优先级：止损/移动止盈触发 → "卖出"（需求 10.1、10.2）——
  if (costTriggered || trailingTriggered) {
    return "卖出";
  }

  // —— 按 health_score 档位映射（需求 10.3–10.6）——
  let suggestion: Suggestion;
  if (health_score >= 80) {
    // [80,100] → "持有"（需求 10.3）
    suggestion = "持有";
  } else if (health_score >= 60) {
    // [60,80) → "继续观察"（需求 10.4）
    suggestion = "继续观察";
  } else if (health_score >= 40) {
    // [40,60) → "减仓"（需求 10.5）
    suggestion = "减仓";
  } else {
    // [0,40) → "卖出"（需求 10.6）
    suggestion = "卖出";
  }

  // —— 趋势转坏下调（需求 10.7）——
  // 未触发止损/止盈且 reduce_half=true 且档位结果为"持有"或"继续观察"时下调为"减仓"
  if (reduce_half && (suggestion === "持有" || suggestion === "继续观察")) {
    suggestion = "减仓";
  }

  return suggestion;
}
