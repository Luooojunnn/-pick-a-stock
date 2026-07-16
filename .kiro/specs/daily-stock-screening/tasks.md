# Implementation Plan: 每日多条件选股（daily-stock-screening）

## Overview

本实现计划将 design.md 的模块划分落地为增量式编码任务：先搭建测试脚手架与基础类型，再自底向上实现纯函数筛选层（`ma`、各 `filter`、分级判定），随后实现带副作用的数据获取层与基准日探测，接着编排 `pipeline` 与 `service`，最后接入 HTTP 路由并做端到端集成测试。

技术栈固定为 **Bun + TypeScript**，测试使用 **`bun test`** 内置运行器 + **`fast-check`**（PBT）。每个纯函数模块都配套单元测试与基于属性的测试（PBT），共覆盖 design.md 的 **Property 1–14**。每条属性用单个属性测试实现、`{ numRuns: 100 }`（≥100 次迭代），并在测试注释中标注：
`// Feature: daily-stock-screening, Property {n}: {text}`

数据获取层的超时/重试/权限识别全部以 mock 做单元与集成测试，不真实调用网络。需求 8（分时）实现为 `INTRADAY_ENABLED = false` 的可插拔占位模块，纯比较函数可测试，默认禁用不排除任何股票。

## Tasks

- [x] 1. 测试脚手架与基础类型
  - [x] 1.1 安装 fast-check 并搭建 bun test 脚手架
    - 执行 `bun add -d fast-check` 安装属性测试库（devDependency，pin 版本）
    - 在 `package.json` 的 `scripts` 增加 `"test": "bun test"`
    - 创建 `src/apis/screening/` 目录结构（含 `filters/` 子目录）
    - 编写一个最小示例测试 `src/apis/screening/scaffold.test.ts` 验证 `bun test` 与 `fast-check` 可运行
    - _Requirements: 10.1_
  - [x] 1.2 定义 screening 模块数据模型与类型（types.ts）
    - 创建 `src/apis/screening/types.ts`
    - 定义 `StockBasicRow`、`DailyRow`、`DailyBasicRow`（Tushare 原始行）
    - 定义 `GradeLabel`、`WorkingCandidate`、`CandidateStock`、`RecommendationResponse`、`ScreeningContext`、`ExclusionRecord`
    - 定义 `FilterDecision` 联合类型与 `Filter` 接口
    - 定义并导出 `ScreeningError`（含 `apiName`、`kind` 字段）
    - _Requirements: 9.2, 9.3, 10.4_
  - [x] 1.3 实现共享数值与区间判定工具（filters/common.ts）
    - 创建 `src/apis/screening/filters/common.ts`
    - 实现 `isValidNumber(x): x is number`（拒绝 null/undefined/NaN/非数值）
    - 实现 `inClosedRange(x, lo, hi)`（闭区间含端点；无效值返回 false）
    - 实现 `recordExclusion(records, ts_code, filter, reason)`：写入 `ExclusionRecord`，且记录本身失败不抛出（保证"即使记录失败仍排除"）
    - _Requirements: 2.4, 3.4, 4.4, 5.4, 6.5_
  - [ ]* 1.4 编写脚手架冒烟测试
    - 断言 `common.ts` 的 `isValidNumber`/`inClosedRange` 在典型输入下的行为
    - _Requirements: 10.1_

- [x] 2. 实现均线计算工具（ma.ts）
  - [x] 2.1 实现 sma 与 isRising
    - 创建 `src/apis/screening/ma.ts`
    - 实现 `sma(closes, period, endIndex)`：数据不足返回 `null`，否则返回窗口内 N 个收盘价算术平均
    - 实现 `isRising(today, prev)`：严格大于且两值均非 null 时为真（相等或更小为假）
    - _Requirements: 7.1, 7.2_
  - [x]* 2.2 编写 sma 属性测试（ma.sma.property.test.ts）
    - **Property 10: 移动平均线计算正确性**
    - **Validates: Requirements 7.1**
    - 生成随机 close 序列与窗口 N，对照朴素算术平均模型；`{ numRuns: 100 }`
  - [x]* 2.3 编写 isRising 属性测试（ma.isRising.property.test.ts）
    - **Property 11: 均线向上判定（严格大于，含相等边界）**
    - **Validates: Requirements 7.2**
    - 生成随机 `(today, prev)`（含相等），断言仅当 today > prev 为真；`{ numRuns: 100 }`
  - [x]* 2.4 编写 ma 单元测试（ma.test.ts）
    - 覆盖数据不足返回 null、窗口边界、null 输入等边界情形
    - _Requirements: 7.1, 7.2_

- [ ] 3. Checkpoint - 确保均线工具测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. 实现全市场截面筛选纯函数（filters/）
  - [x] 4.1 实现主板筛选（filters/main-board.ts）
    - 判定 `market === "主板"` 且代码前缀 ∈ {600,601,603,605,000,001,002}
    - 排除创业板 300/301、科创板 688/689、北交所 8/4 开头；排除优先于保留
    - _Requirements: 1.2, 1.3, 1.4_
  - [x]* 4.2 编写主板筛选属性测试（main-board.property.test.ts）
    - **Property 1: 主板筛选与排除优先级**
    - **Validates: Requirements 1.2, 1.3, 1.4**
    - 随机 `market` + 各板块前缀（含冲突边界）；`{ numRuns: 100 }`
  - [x] 4.3 实现涨幅筛选（filters/pct-chg.ts）
    - 复用 `inClosedRange` 判定 3 ≤ pct_chg ≤ 5（含端点）；无效值排除并记录
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x]* 4.4 编写涨幅筛选属性测试（pct-chg.property.test.ts）
    - **Property 3: 涨幅区间筛选（含端点 3、5）**
    - **Validates: Requirements 2.2, 2.3**
    - 随机浮点覆盖 3、5 端点；`{ numRuns: 100 }`
  - [x] 4.5 实现量比筛选（filters/volume-ratio.ts）
    - 判定 volume_ratio ≥ 1（含端点 1）；无效值排除并记录
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x]* 4.6 编写量比筛选属性测试（volume-ratio.property.test.ts）
    - **Property 4: 量比阈值筛选（含端点 1）**
    - **Validates: Requirements 3.2, 3.3**
    - 随机浮点覆盖 1；`{ numRuns: 100 }`
  - [x] 4.7 实现换手率筛选（filters/turnover-rate.ts）
    - 判定 5 ≤ turnover_rate ≤ 10（含端点）；无效值排除并记录
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x]* 4.8 编写换手率筛选属性测试（turnover-rate.property.test.ts）
    - **Property 5: 换手率区间筛选（含端点 5、10）**
    - **Validates: Requirements 4.2, 4.3**
    - 随机浮点覆盖 5、10 端点；`{ numRuns: 100 }`
  - [x] 4.9 实现流通市值筛选（filters/circ-mv.ts）
    - 判定 500000 ≤ circ_mv ≤ 2000000（含两端端点）；无效值排除并记录
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x]* 4.10 编写流通市值筛选属性测试（circ-mv.property.test.ts）
    - **Property 6: 流通市值区间筛选（含端点 500000、2000000）**
    - **Validates: Requirements 5.2, 5.3**
    - 随机数值覆盖两端点；`{ numRuns: 100 }`
  - [x]* 4.11 编写无效值排除属性测试（invalid-values.property.test.ts）
    - **Property 7: 无效字段值一律排除并记录**
    - **Validates: Requirements 2.4, 3.4, 4.4, 5.4**
    - 对四个截面 filter 注入无效值集合 {null,undefined,NaN,"",非数值}，断言一律排除且生成排除记录；`{ numRuns: 100 }`

- [x] 5. 实现历史序列筛选纯函数（filters/）
  - [x] 5.1 实现成交量递增分级判定（filters/volume-increasing.ts）
    - 实现 `classifyVolume(recent)`：不足 3 条或含缺失/≤0 → 排除并记录；严格递增 → 仅"理想条件"；非严格递增 → 仅"放宽条件"；否则排除
    - 分级互斥由 if/else if 控制流保证
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x]* 5.2 编写成交量分级互斥属性测试（volume-increasing.grade.property.test.ts）
    - **Property 8: 成交量递增分级判定与互斥**
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - 随机三元组（含相等），断言分级正确且绝不同时具两个标注；`{ numRuns: 100 }`
  - [x]* 5.3 编写成交量数据不足属性测试（volume-increasing.invalid.property.test.ts）
    - **Property 9: 成交量数据不足或非法一律排除**
    - **Validates: Requirements 6.5**
    - 生成长度 <3 或含缺失/≤0 的序列，断言一律排除并生成记录；`{ numRuns: 100 }`
  - [x] 5.4 实现均线趋势分级判定（filters/ma-trend.ts）
    - 实现 `classifyMaTrend(closes)`：<11 日 → 排除并标数据不足；MA5 或 MA10 不向上 → 排除；≥61 日且多头排列且四线向上 → 仅"理想条件"；否则 → "放宽条件"
    - 复用 `ma.sma` 与 `ma.isRising`；分级互斥由控制流保证
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x]* 5.5 编写均线趋势分级属性测试（ma-trend.property.test.ts）
    - **Property 12: 均线趋势分级判定、互斥与数据长度分支**
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7**
    - 构造多头/非多头/长度 10/11/60/61 序列，断言分级、互斥与长度分支；`{ numRuns: 100 }`
  - [x]* 5.6 编写均线趋势单元测试（ma-trend.test.ts）
    - 覆盖历史 close < 11 日 → 排除并标"数据不足"（需求 7.7 边界示例）
    - _Requirements: 7.7_

- [ ] 6. Checkpoint - 确保筛选纯函数层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. 实现分时对比占位模块（filters/intraday.ts，默认禁用）
  - [x] 7.1 实现占位过滤与纯比较函数
    - 创建 `src/apis/screening/filters/intraday.ts`，声明 `const INTRADAY_ENABLED = false`
    - 实现 `applyIntradayFilter(candidates, ctx)`：禁用时原样透传候选、不调用任何分钟接口、不排除
    - 实现可测试纯比较函数：以开盘价换算涨跌幅、按对齐时间点比较、计算占比（个股 ≥ 大盘的对齐点数 / 有效对齐点总数）
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [x]* 7.2 编写占位透传单元测试（intraday.disabled.test.ts）
    - 断言 `INTRADAY_ENABLED=false` 时候选集原样返回、未触发任何分钟接口调用
    - _Requirements: 8.6_
  - [x]* 7.3 编写纯比较函数单元测试（intraday.compare.test.ts）
    - 覆盖占比计算、仅比较双方均有数据的对齐点、有效对齐点为 0 时不排除
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 8. 实现数据获取层（data-source.ts）
  - [x] 8.1 实现 fetchWithPolicy 与数据获取封装
    - 创建 `src/apis/screening/data-source.ts`
    - 实现 `fetchWithPolicy`：`AbortController` 超时（默认 30s，换手率场景 10s）、瞬时错误重试（≤3 次、间隔 ≥1s）、权限不足识别（不重试，抛权限类 `ScreeningError`）
    - 实现 `fetchStockBasic`、`fetchDailyByDate`、`fetchDailyBasicByDate`、`fetchDailyHistory`（经 `callTushare` 调用，仅 `stock_basic`/`daily`/`daily_basic`，无 `rt_*`）
    - 空结果判定与失败时携带失败接口名
    - _Requirements: 4.5, 5.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x]* 8.2 编写数据获取层单元测试（data-source.unit.test.ts，mock）
    - mock `callTushare`：断言超时触发、瞬时失败重试 ≤3 次且相邻间隔 ≥1s、权限错误重试次数为 0
    - _Requirements: 10.4, 10.5, 10.6_
  - [x]* 8.3 编写数据获取层集成测试（data-source.integration.test.ts，mock）
    - mock 持续失败/超时：断言中止、错误含失败接口名（10.4）；断言权限不足抛权限类错误（10.6）
    - 断言换手率/流通市值接口失败时上抛错误、保留调用前候选集不变（4.5、5.5）
    - _Requirements: 4.5, 5.5, 10.4, 10.6_

- [x] 9. 实现基准日探测（reference-day.ts）
  - [x] 9.1 实现 resolveReferenceDay
    - 创建 `src/apis/screening/reference-day.ts`
    - 用 `trade_cal`（exchange=SSE，is_open=1）获取交易日历；当前未过 15:00 则起始探测日前推一日
    - 逐个候选交易日探测 `daily`/`daily_basic` 均非空即为基准日；回溯上限 7 个交易日，超限抛 `ScreeningError('no-reference-day')`
    - _Requirements: 1.5, 1.7_
  - [ ]* 9.2 编写基准日回溯属性测试（reference-day.property.test.ts）
    - **Property 2: 基准日回溯正确性**
    - **Validates: Requirements 1.5, 1.7**
    - 随机"每日 daily/daily_basic 可用性"布尔序列（mock 数据源），断言选中第一个双非空交易日且回溯 ≤7；`{ numRuns: 100 }`
  - [ ]* 9.3 编写基准日单元测试（reference-day.test.ts，mock）
    - 覆盖连续 7 交易日无数据 → 抛"无可用基准日"错误
    - _Requirements: 1.7_

- [x] 10. 实现筛选管线编排（pipeline.ts）
  - [x] 10.1 实现 pipeline 串联与短路
    - 创建 `src/apis/screening/pipeline.ts`
    - 阶段 A：按主板→涨幅→量比→换手率→流通市值顺序串联截面 filter，任一排除即短路并写入诊断记录
    - 阶段 B：对幸存候选执行成交量递增→均线趋势判定并生成分级标注
    - 复用 filters/ 各纯函数与 `common.ts` 记录器；本模块不产生 I/O
    - _Requirements: 1.2, 1.3, 1.4, 2.2, 2.3, 3.2, 3.3, 4.2, 4.3, 5.2, 5.3, 6.2, 6.3, 6.4, 7.3, 7.4, 7.5, 7.6, 7.7_

- [x] 11. 实现筛选服务编排与结果组装（service.ts）
  - [x] 11.1 实现 runScreening 与候选组装
    - 创建 `src/apis/screening/service.ts`
    - 编排：`fetchStockBasic`（空/失败抛错）→ `resolveReferenceDay`（无则抛错）→ 拉取基准日截面 → 阶段 A/B pipeline → 阶段 C `applyIntradayFilter`（禁用透传）
    - 阶段 B 拉取历史序列采用方案 A（按候选分批拉取，批间留间隔）
    - 实现 `assembleCandidate`：将 `WorkingCandidate` 组装为含 `ts_code,name,volumeGrade,maGrade` 的 `CandidateStock`
    - _Requirements: 1.1, 1.6, 1.7, 9.1, 9.2, 9.3, 9.4_
  - [ ]* 11.2 编写输出结构属性测试（service.output.property.test.ts）
    - **Property 13: 候选输出结构完整性**
    - **Validates: Requirements 9.2**
    - 随机 `WorkingCandidate`，断言组装结果含四字段且分级取值 ∈ {"理想条件","放宽条件"}；`{ numRuns: 100 }`
  - [ ]* 11.3 编写空结果不报错属性测试（service.empty.property.test.ts）
    - **Property 14: 空结果不视为错误**
    - **Validates: Requirements 9.3, 9.4**
    - mock 数据源，构造使候选为空/非空的输入，断言无接口级错误时 code 恒为 0 且 data 恒为数组；`{ numRuns: 100 }`
  - [ ]* 11.4 编写服务编排单元测试（service.test.ts，mock）
    - 覆盖 `stock_basic` reject/超时/空数组三例 → 抛错（1.6）；`runScreening` 抛错场景（9.5）
    - _Requirements: 1.6, 9.5_

- [ ] 12. Checkpoint - 确保服务层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. HTTP 路由接入与集成
  - [x] 13.1 替换 get-the-daily-recommendations.ts 占位逻辑
    - 修改 `src/apis/get-the-daily-recommendations.ts`：调用 `runScreening()`，成功返回 `{ code: 0, data }`，捕获错误返回 `{ code: -1, message }` + HTTP 500
    - 保持 `export const route` 约定与 `src/index.ts` 路由注入不变
    - _Requirements: 9.1, 9.3, 9.4, 9.5_
  - [ ]* 13.2 编写端到端集成测试（daily-recommendations.integration.test.ts，mock）
    - mock 数据源跑一次完整筛选：断言候选来自 pipeline、`stock_basic` 以 `list_status=L` 调用一次、空结果返回 code 0、抛错返回 code -1 + status 500 且无 data
    - _Requirements: 1.1, 9.1, 9.3, 9.4, 9.5_
  - [ ]* 13.3 编写调用约束 SMOKE 测试（call-constraints.smoke.test.ts，mock）
    - 断言全流程仅调用 `stock_basic`/`daily`/`daily_basic`/`trade_cal`，无任何 `rt_*` 调用
    - _Requirements: 10.1, 10.2, 10.3_

- [ ] 14. 最终校验 - 用属性测试验证全部正确性属性
  - 运行 `bun test`，确认 Property 1–14 全部属性测试通过（每条 ≥100 次迭代），且单元/集成/SMOKE 测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记为 `*` 的子任务为可选测试任务，可为快速 MVP 跳过；核心实现任务不标记为可选。
- 每个任务标注对应的需求编号（_Requirements_）与相关设计属性（Property n），便于追溯。
- 每条正确性属性（Property 1–14）用单个属性测试实现，`{ numRuns: 100 }`，并在测试注释首行标注 `// Feature: daily-stock-screening, Property {n}: {text}`。
- 属性测试与单元测试互补：属性测试覆盖纯逻辑普遍性，单元/集成测试覆盖外部行为（超时、重试、权限、错误分类）与具体边界示例。
- 数据获取层的超时/重试/权限识别一律以 mock 测试，不真实调用网络。
- 需求 8 以 `INTRADAY_ENABLED=false` 占位，纯比较函数可测试但默认禁用、不排除任何股票；分钟权限开通后仅需置位并接入取数。
- 每个任务均建立在前序步骤产物之上，最终由任务 13 接入 HTTP 路由，无孤立或未集成代码。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "4.1", "4.3", "4.5", "4.7", "4.9", "5.1", "7.1", "8.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "4.2", "4.4", "4.6", "4.8", "4.10", "4.11", "5.4", "7.2", "7.3", "8.2", "8.3", "9.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.5", "5.6", "9.2", "9.3", "10.1"] },
    { "id": 5, "tasks": ["11.1"] },
    { "id": 6, "tasks": ["11.2", "11.3", "11.4", "13.1"] },
    { "id": 7, "tasks": ["13.2", "13.3"] }
  ]
}
```
