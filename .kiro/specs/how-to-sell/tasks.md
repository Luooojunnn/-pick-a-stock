# Implementation Plan: 我的股票合适卖（how-to-sell）

## Overview

按设计文档的分层结构与"计算顺序硬约束"逐步实现：先建立类型骨架，再实现纯函数计算层（代码补全 / 输入校验 / 指标），随后按依赖顺序实现五层策略（成本止损 → 趋势 → 分批止盈 → 成交量确认 → 健康评分 → 移动止盈 → 综合建议），再实现数据获取层与服务编排，最后接入 HTTP 路由与前端页面。

全部使用 TypeScript（后端 Bun + `Bun.serve`，前端 React 19 + antd v6 + react-router-dom v7），测试运行器为 Bun 内置 `bun test`（单次执行），属性测试使用已安装的 `fast-check`（每条属性最少 100 次迭代），测试文件与被测模块同目录、命名 `*.test.ts` / `*.test.tsx`。

## Tasks

- [x] 1. 建立类型定义与模块目录骨架
  - [x] 1.1 定义 `sell-advisor/types.ts` 数据模型与错误类型
    - 创建 `src/apis/sell-advisor/types.ts`
    - 定义 `DailyBar`、`PositionInputRaw`、`NormalizedInput`、`MASnapshot`、`TakeProfitTarget`、`DimensionScore`、`SellAdvice`、`Suggestion`、`TrendState` 类型
    - 定义错误类 `ValidationError`（→ 400）与 `SellAdvisorError`（含 `apiName`、`kind: "timeout" | "permission" | "insufficient-data" | "generic"`，→ 500）
    - _Requirements: 11.2, 11.5, 11.6_

- [x] 2. 实现代码补全与输入校验（纯函数）
  - [x] 2.1 实现 `code.ts` 的 `toFullCode`
    - 创建 `src/apis/sell-advisor/code.ts`，实现 `toFullCode(code: string): string | null`
    - 规则：6 位纯数字；首字符 `6` → `${code}.SH`；首字符 `0` → `${code}.SZ`；其余 → `null`
    - _Requirements: 1.9, 1.10_

  - [ ]* 2.2 为 `toFullCode` 编写属性测试
    - 创建 `src/apis/sell-advisor/code.test.ts`
    - **Property 1: 代码补全正确性**
    - 生成器覆盖首位 6 / 0 / 其它；断言补全后前 6 位等于原 `code`
    - **Validates: Requirements 1.9, 1.10**

  - [x] 2.3 实现 `validation.ts` 的 `validatePositionInput`
    - 创建 `src/apis/sell-advisor/validation.ts`，实现 `validatePositionInput(raw: unknown): NormalizedInput`
    - 复用 `toFullCode` 校验 `code`；校验 `cost`（数值、0.01–999999.99、小数位 ≤ 2）、`position`（整数、1–9999999999）、可选 `buy_date`（合法 YYYYMMDD 且 19901219 ≤ buy_date ≤ 今日）
    - 校验失败抛 `ValidationError`，通过返回含 `full_code` 的 `NormalizedInput`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.10_

  - [ ]* 2.4 为 `validatePositionInput` 编写属性测试
    - 追加到 `src/apis/sell-advisor/validation.test.ts`
    - **Property 2: 输入校验接受域（数值与日期）**
    - 生成器覆盖 cost 端点（0.01 / 999999.99 / 3 位小数）、position 端点（1 / 9999999999）、buy_date 端点（19901219 / 今日）与非法值
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.10**

- [x] 3. 实现指标计算 `indicators.ts`（纯函数）
  - [x] 3.1 实现指标计算函数集
    - 创建 `src/apis/sell-advisor/indicators.ts`
    - 实现 `round(x, digits)`、`validBars(bars)`、`profitPct(currentPrice, cost)`、`trueRange(high, low, prevClose)`、`atr14(bars)`、`sma(closes, period, endIndex)`、`highestClose(bars, fromIndex?)`、`changePct(recent, prev)`
    - `validBars` 过滤 open/high/low/close/vol 均有效且 `close > 0`；`atr14` 可用日 < 15 返回 null 并保留 4 位；`profitPct` 保留 2 位
    - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3, 4.2, 5.1, 6.1, 8.1_

  - [ ]* 3.2 为 `validBars` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 3: 有效交易日过滤**
    - 生成器混入缺字段 / null / NaN / `close ≤ 0` 的行，断言输出集合与相对顺序
    - **Validates: Requirements 2.3**

  - [ ]* 3.3 为 `profitPct` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 6: 盈亏计算（公式、符号与精度）**
    - 生成器覆盖 `current ≷ cost`，断言公式、符号与保留 2 位
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [ ]* 3.4 为 `trueRange` / `atr14` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 8: TR 与 ATR14 计算（模型对照）**
    - 生成器随机 OHLC，覆盖可用日 14 / 15 边界
    - **Validates: Requirements 4.2**

  - [ ]* 3.5 为 `sma` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 11: 移动平均线计算（模型对照）**
    - 生成器随机 close 序列 + 窗口 N ∈ {5,10,20,60}，与朴素均值模型对照
    - **Validates: Requirements 5.1**

  - [ ]* 3.6 为 `highestClose` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 13: 持有期最高价**
    - 生成器含可选起点 `fromIndex` 与空区间（返回 null）
    - **Validates: Requirements 6.1, 1.7, 6.4**

  - [ ]* 3.7 为 `changePct` 编写属性测试
    - 追加到 `src/apis/sell-advisor/indicators.test.ts`
    - **Property 18: 变动百分比计算**
    - 生成器 `recent`、`prev ≠ 0`
    - **Validates: Requirements 8.1**

- [x] 4. 检查点 - 确保计算基础层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 实现第一层——成本止损 `strategy/stop-loss.ts`
  - [x] 5.1 实现 `computeStopLoss`
    - 创建 `src/apis/sell-advisor/strategy/stop-loss.ts`
    - 实现 `computeStopLoss(cost, atr, currentPrice)`：`fixed_stop_loss = round(cost×0.93,2)`；ATR 可用时 `atr_stop_loss = round(cost - atr×2, 2)` 且 `stop_loss = max(fixed, atr)`，否则 `atr_stop_loss = null`、`stop_loss = fixed`；`cost_stop_triggered = current ≤ stop_loss`
    - `cost ≤ 0` / 缺失时三项止损置 null（防御分支）
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 5.2 为固定止损编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/stop-loss.test.ts`
    - **Property 7: 固定止损计算**
    - **Validates: Requirements 4.1**

  - [ ]* 5.3 为 ATR 止损与推荐止损编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/stop-loss.test.ts`
    - **Property 9: ATR 止损与推荐止损取值**
    - 生成器覆盖 atr = null 与可用日 < 15 场景
    - **Validates: Requirements 4.3, 4.4, 4.5**

  - [ ]* 5.4 为成本止损触发标记编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/stop-loss.test.ts`
    - **Property 10: 成本止损触发标记**
    - **Validates: Requirements 4.6**

- [x] 6. 实现第二层——趋势判断 `strategy/trend.ts`
  - [x] 6.1 实现 `computeTrend`
    - 创建 `src/apis/sell-advisor/strategy/trend.ts`
    - 实现 `computeTrend(ma: MASnapshot, currentPrice)`：返回 MA5/10/20/60、`trend ∈ {强势,转坏,中性,数据不足}`、`reduce_half`（趋势转坏为 true）
    - _Requirements: 5.2, 5.3, 5.4, 5.6_

  - [ ]* 6.2 为趋势判断编写属性测试
    - 创建 `src/apis/sell-advisor/strategy/trend.test.ts`
    - **Property 12: 趋势状态四态完整互斥划分与减仓联动**
    - 生成器覆盖 current 与 MA 的相等边界
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.6**

- [x] 7. 实现第四层——分批止盈 `strategy/take-profit.ts`
  - [x] 7.1 实现 `computeTakeProfit`
    - 创建 `src/apis/sell-advisor/strategy/take-profit.ts`
    - 实现 `computeTakeProfit(cost, currentPrice)`：两档 `cost×1.20/0.3/"盈利20%锁定利润"`、`cost×1.40/0.4/"盈利40%继续减仓"`，price 保留 2 位；标注 `reached`；`cost ≤ 0` 时返回空数组（防御分支）
    - _Requirements: 7.1, 7.2, 7.4, 7.5_

  - [ ]* 7.2 为分批止盈目标生成编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/take-profit.test.ts`
    - **Property 16: 分批止盈目标生成**
    - **Validates: Requirements 7.1, 7.2, 11.4**

  - [ ]* 7.3 为分批止盈达到标记编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/take-profit.test.ts`
    - **Property 17: 分批止盈达到标记**
    - 生成器含 `currentPrice` 无效 / 缺失场景
    - **Validates: Requirements 7.4**

  - [ ]* 7.4 为保留仓位说明编写单元测试
    - 追加到 `src/apis/sell-advisor/strategy/take-profit.test.ts`
    - 断言两档 `ratio` 合计 = 0.7、存在剩余 30% 仓位说明
    - _Requirements: 7.3_

- [x] 8. 实现第五层——成交量确认 `strategy/volume-confirm.ts`
  - [x] 8.1 实现 `tightenRetreatRatio`
    - 创建 `src/apis/sell-advisor/strategy/volume-confirm.ts`
    - 实现 `tightenRetreatRatio(baseRatio, bars)`：量价背离（价变动 > 0% 且量变动 < -20%）时 `retreat_ratio = max(base-0.02, 0)`；有效日不足 2 或量缺失 → `volume_confirm_executed = false` 且保持 base
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 8.2 为量价背离判定与回撤收紧编写属性测试
    - 创建 `src/apis/sell-advisor/strategy/volume-confirm.test.ts`
    - **Property 19: 量价背离判定与回撤收紧**
    - 生成器覆盖 Δvol = -20% 边界与不足 2 日场景
    - **Validates: Requirements 8.2, 8.3, 8.4**

- [x] 9. 实现健康评分 `strategy/health-score.ts`（依赖趋势）
  - [x] 9.1 实现 `computeHealthScore`
    - 创建 `src/apis/sell-advisor/strategy/health-score.ts`
    - 实现 `computeHealthScore(inputs: ScoreInputs)`：趋势(0–30)+价格(0–20)+成交量(0–20)+资金(0–20)+风险(0–10) 求和为 0–100 整数；返回 `dimensions` 五维度明细；`stop_loss` 不可用或 `current ≤ 0` 时风险维度记 0 并标注不可计算
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.9_

  - [ ]* 9.2 为趋势维度得分编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 20: 趋势维度得分（0–30）**
    - **Validates: Requirements 9.2**

  - [ ]* 9.3 为价格维度得分编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 21: 价格维度得分（0–20）**
    - 生成器覆盖 profit_pct 端点 20 / 10 / 0 / -7
    - **Validates: Requirements 9.3**

  - [ ]* 9.4 为成交量维度得分编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 22: 成交量维度得分（0–20）**
    - 生成器覆盖三日量严格递增 / 非严格递增 / 其它
    - **Validates: Requirements 9.4**

  - [ ]* 9.5 为资金维度得分编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 23: 资金维度得分（0–20）**
    - **Validates: Requirements 9.5**

  - [ ]* 9.6 为风险维度得分与不可计算兜底编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 24: 风险维度得分（0–10）与不可计算兜底**
    - 生成器覆盖 m 端点 2 / 5 与 `stop_loss = null`
    - **Validates: Requirements 9.6, 9.9**

  - [ ]* 9.7 为评分求和与取值域编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/health-score.test.ts`
    - **Property 25: 健康评分求和与取值域**
    - **Validates: Requirements 9.1, 9.7**

- [x] 10. 实现第三层——移动止盈 `strategy/trailing-stop.ts`（依赖评分定档）
  - [x] 10.1 实现 `computeTrailingStop`
    - 创建 `src/apis/sell-advisor/strategy/trailing-stop.ts`
    - 实现 `computeTrailingStop(highestPrice, retreatRatio, currentPrice)`：`trailing_stop = round(highest×(1-r),2)`；`highest` 不可用 → `trailing_stop = null`；`trailing_triggered` 当且仅当二者可用且 `current ≤ trailing_stop`
    - _Requirements: 6.2, 6.4, 6.5_

  - [ ]* 10.2 为移动止盈线计算与可用性编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/trailing-stop.test.ts`
    - **Property 14: 移动止盈线计算与可用性**
    - 生成器含 `highest = null`
    - **Validates: Requirements 6.2, 6.4**

  - [ ]* 10.3 为移动止盈触发标记编写属性测试
    - 追加到 `src/apis/sell-advisor/strategy/trailing-stop.test.ts`
    - **Property 15: 移动止盈触发标记**
    - **Validates: Requirements 6.5**

- [x] 11. 实现综合建议 `strategy/suggestion.ts`
  - [x] 11.1 实现 `decideSuggestion`
    - 创建 `src/apis/sell-advisor/strategy/suggestion.ts`
    - 实现 `decideSuggestion(ctx: SuggestionContext)`：止损/移动止盈触发 → "卖出"（优先）；否则按 health_score 档位 `[80,100]→持有`、`[60,80)→继续观察`、`[40,60)→减仓`、`[0,40)→卖出`；未触发且 `reduce_half` 且档位为持有/继续观察时下调为"减仓"；输入缺失/越界抛数据不可用错误（防御分支）
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [ ]* 11.2 为综合建议决策编写属性测试
    - 创建 `src/apis/sell-advisor/strategy/suggestion.test.ts`
    - **Property 26: 综合建议决策**
    - 生成器覆盖档位端点 40/60/80/100 与 `reduce_half` 组合
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 11.3**

- [x] 12. 检查点 - 确保全部策略层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. 实现数据获取层 `data-source.ts`
  - [x] 13.1 实现 `fetchWithPolicy` 与 `fetchDailyHistory`
    - 创建 `src/apis/sell-advisor/data-source.ts`
    - 实现 `fetchWithPolicy<T>(apiName, params, fields, opts?)`：`AbortController` 30s 超时、瞬时错误重试 ≤3 次且间隔 ≥1s、权限不足不重试并抛权限错误
    - 实现 `fetchDailyHistory(fullCode): Promise<DailyBar[]>`：调用 `daily` / `pro_bar`，回溯覆盖 ≥75 交易日（`LOOKBACK_DAYS = 120`），按 trade_date 升序；绝不调用 `rt_*`
    - 提供 `__setCallTushare` / `__resetCallTushare` 注入点（参照 screening 模式）
    - _Requirements: 2.1, 2.2, 2.6, 2.7_

  - [ ]* 13.2 为数据获取层编写集成测试（mock 数据源）
    - 创建 `src/apis/sell-advisor/data-source.test.ts`，通过 `__setCallTushare` 注入 mock
    - 断言：持续失败/超时时重试次数 ≤ 3 且相邻间隔 ≥ 1 秒、错误含失败接口名；成功时返回按 trade_date 升序、字段齐全、区间覆盖 ≥ 75 交易日；断言调用 `api_name` 仅 `daily` / `pro_bar`，无任何 `rt_*`
    - _Requirements: 2.1, 2.2, 2.6, 2.7_

- [x] 14. 实现服务编排 `service.ts`
  - [x] 14.1 实现 `computeSellAdvice` 编排
    - 创建 `src/apis/sell-advisor/service.ts`，实现 `computeSellAdvice(rawInput): Promise<SellAdvice>`
    - 按固定顺序编排：`validatePositionInput` → `fetchDailyHistory` → `validBars`（空或 < 60 抛 `insufficient-data`）→ current_price/profit_pct → atr14/computeStopLoss → MA 快照/computeTrend → computeHealthScore → 评分定档回撤比例(8%/5%) → tightenRetreatRatio → computeTrailingStop → computeTakeProfit → decideSuggestion → 组装 `SellAdvice`
    - _Requirements: 2.4, 2.5, 5.5, 6.3, 9.8_

  - [ ]* 14.2 为当前价取值编写属性测试
    - 追加到 `src/apis/sell-advisor/service.test.ts`（mock 数据源）
    - **Property 4: 当前价取最近有效交易日收盘价**
    - **Validates: Requirements 2.4**

  - [ ]* 14.3 为历史数据不足中止编写属性测试
    - 追加到 `src/apis/sell-advisor/service.test.ts`（mock 数据源）
    - **Property 5: 历史数据不足即中止**
    - 生成器覆盖有效日 59 / 60 / 61 边界
    - **Validates: Requirements 2.5, 5.5, 9.8**

  - [ ]* 14.4 为成功输出结构完整性编写属性测试
    - 追加到 `src/apis/sell-advisor/service.test.ts`（mock 数据源）
    - **Property 27: 成功输出结构完整性**
    - **Validates: Requirements 6.3, 11.2**

  - [ ]* 14.5 为服务端到端编写集成测试（mock 数据源）
    - 追加到 `src/apis/sell-advisor/service.test.ts`
    - 端到端跑一次断言以 `full_code` 调 `daily`、成功返回结构；非法输入抛 `ValidationError`；接口失败/数据不足抛 `SellAdvisorError` 且无部分结果
    - _Requirements: 2.1, 2.2, 11.1, 11.5, 11.6_

- [x] 15. 检查点 - 确保数据层与服务层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. 接入 HTTP 路由并注入服务器
  - [x] 16.1 实现 `how-to-sell.ts` 路由
    - 创建 `src/apis/how-to-sell.ts`，导出 `export const route`，实现 `POST /api/how-to-sell`
    - 解析 JSON body（非法 JSON → 400）；调用 `computeSellAdvice`；成功 `{ code: 0, data }` + 200；`ValidationError` → `{ code: -1, message }` + 400；其余 → + 500
    - _Requirements: 11.1, 11.2, 11.5, 11.6_

  - [x] 16.2 将路由注入 `src/index.ts`
    - 在 `src/index.ts` 中 `import { route as howToSellRoute }` 并在 `routes` 中展开 `...howToSellRoute`
    - _Requirements: 11.1_

- [x] 17. 实现前端页面并注册路由
  - [x] 17.1 实现 `HowToSell.tsx` 页面
    - 创建 `src/pages/HowToSell.tsx`：表单录入 code/cost/position/buy_date（前端即时校验，复用 `toFullCode` 同规则），提交前校验并保留其它字段值
    - 调用 `POST /api/how-to-sell`，10s 超时（AbortController）→ 超时提示；请求中显示加载指示器并禁用按钮
    - 成功用 antd `Table` 展示 current_price/profit_pct/suggestion/stop_loss/trailing_stop/highest_price/health_score 与 take_profit 各档（空数组显示占位）；错误保留输入不渲染表格
    - 实现并导出建议视觉分类函数（{卖出,减仓} 与 {持有,继续观察} 映射不同颜色标识）
    - _Requirements: 1.1, 1.2, 1.3, 1.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [x] 17.2 在 `App.tsx` 注册 `/how-to-sell` 路由
    - 在 `src/App.tsx` 中 import `HowToSell` 并新增 `<Route path="/how-to-sell" element={<HowToSell />} />`
    - _Requirements: 1.1_

  - [ ]* 17.3 为建议视觉分类编写属性测试
    - 创建 `src/pages/HowToSell.test.tsx`
    - **Property 28: 建议视觉分类可区分**
    - 断言任一"卖出/减仓"与任一"持有/继续观察"颜色标识必然不同
    - **Validates: Requirements 12.8**

  - [ ]* 17.4 为前端页面编写示例测试
    - 追加到 `src/pages/HowToSell.test.tsx`（mock fetch）
    - 覆盖表单渲染四输入项、合法提交触发请求、10s 超时提示、加载指示器与控件禁用、成功渲染 Table、take_profit 为空的占位、错误保留输入
    - _Requirements: 1.1, 1.2, 1.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

- [x] 18. 最终检查点 - 确保全部测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记 `*` 的子任务为可选测试任务，可为快速 MVP 跳过；非 `*` 任务为核心实现，必须执行。
- 每个任务标注所验证的具体需求编号，便于追溯。
- 属性测试均使用 `fast-check`、最少 100 次迭代，测试文件与被测模块同目录、用 `bun test` 运行。
- 计算顺序硬约束（评分 → 定档 → 成交量收紧 → 移动止盈线 → 综合建议）在 `service.ts`（任务 14.1）中固定。
- 数据获取层的重试/超时/权限、仅调 `daily`/`pro_bar` 等外部/时序行为由集成测试覆盖（任务 13.2、14.5），不做属性测试。
- 前端 UI 展示行为由示例测试覆盖（任务 17.4），仅"建议视觉分类"纯函数适合属性测试（任务 17.3）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "5.1", "6.1", "7.1", "8.1", "9.1", "10.1", "11.1", "13.1"] },
    { "id": 2, "tasks": ["2.3", "2.2", "3.2", "5.2", "6.2", "7.2", "8.2", "9.2", "10.2", "11.2", "13.2"] },
    { "id": 3, "tasks": ["14.1", "2.4", "3.3", "5.3", "7.3", "9.3", "10.3"] },
    { "id": 4, "tasks": ["16.1", "17.1", "3.4", "5.4", "7.4", "9.4", "14.2"] },
    { "id": 5, "tasks": ["16.2", "17.2", "17.3", "3.5", "9.5", "14.3"] },
    { "id": 6, "tasks": ["17.4", "3.6", "9.6", "14.4"] },
    { "id": 7, "tasks": ["3.7", "9.7", "14.5"] }
  ]
}
```
