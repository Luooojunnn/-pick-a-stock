# Requirements Document

## Introduction

本功能（daily-stock-screening，每日多条件选股）旨在把现有的占位实现 `src/apis/get-the-daily-recommendations.ts` 升级为真正的多条件选股筛选服务，服务于"今日推荐"页面（`src/pages/TodaysRecommendation.tsx`）。

系统在每个交易日收盘后，基于 Tushare Pro 的当日收盘数据，对沪深主板股票执行一组量价与均线条件筛选，输出符合条件的候选股票列表，并通过现有的 `GET /api/daily-recommendations` 接口返回给前端。

关键前提与约束：

- 全部使用收盘后的当日入库数据（`daily` 每日 15:00–16:00 入库，`daily_basic` 15:00–17:00 入库），不使用任何实时 `rt_*` 接口。
- 用户 Tushare 账号积分 ≥ 2000，可访问 `daily`、`daily_basic` 接口；但【未开通分钟权限】，无法访问 `stk_mins`、`idx_mins`。
- 因此本文档定义 8 类筛选条件，其中第 8 类（分时数据比较）依赖分钟权限，在当前版本中【不实现】，明确标注为后续开通权限后接入，不阻塞前 7 类筛选流程。

## Glossary

- **筛选服务 / Screening_Service**：本功能的后端筛选逻辑，接收当日数据、执行多条件筛选并返回候选股票列表。
- **推荐接口 / Recommendation_API**：现有 HTTP 接口 `GET /api/daily-recommendations`，用于向前端返回筛选结果。
- **Tushare_Client**：封装 Tushare Pro HTTP 调用的模块（`src/apis/_tushare.ts` 中的 `callTushare` 函数）。
- **交易日 / Trading_Day**：证券交易所实际开市的自然日；筛选基于最近一个已收盘且数据已入库的交易日。
- **基准日 / Reference_Trading_Day**：筛选所依据的交易日，即最近一个已过 15:00 收盘时刻、且 `daily` 与 `daily_basic` 均可查询到该日非空数据的交易日。
- **沪深主板股票 / Main_Board_Stock**：在上海或深圳证券交易所主板上市的股票，排除创业板（300/301 开头）、科创板（688/689 开头）、北交所（8 开头、4 开头等）。判定标准为 `stock_basic` 的 `market` 字段等于"主板"，且代码前缀满足：沪市 600/601/603/605 开头，深市 000/001/002 开头。
- **涨幅 / pct_chg**：`daily` 接口返回的当日涨跌幅字段，单位为百分比（如 3.5 表示 3.5%）。
- **成交量 / vol**：`daily` 接口返回的当日成交量字段（单位：手）。
- **收盘价 / close**：`daily` 接口返回的当日收盘价字段，用于自行计算移动平均线。
- **量比 / volume_ratio**：`daily_basic` 接口返回的量比字段（大于 0 的浮点数），表示当日成交量相对近期平均成交量的比值（放量指标，非排名）。
- **换手率 / turnover_rate**：`daily_basic` 接口返回的当日换手率字段，单位为百分比，取值范围 0 至 100。
- **流通市值 / circ_mv**：`daily_basic` 接口返回的流通市值字段，单位为万元（50 亿 = 500000 万元，200 亿 = 2000000 万元）。
- **移动平均线 / MA**：由收盘价计算的 N 日简单移动平均值，涉及 MA5、MA10、MA20、MA60。
- **均线向上 / MA_Rising**：某条均线满足"当日均线值严格大于前一交易日均线值"；两值相等或当日小于前一日均视为不向上。
- **多头排列 / Bullish_Alignment**：当日满足 MA5 > MA10 > MA20 > MA60，且各条均线均向上。
- **理想条件 / Ideal_Criteria**：某项筛选的严格版本（如成交量严格递增、多头排列）。
- **放宽条件 / Relaxed_Criteria**：某项筛选的宽松版本（如成交量非严格递增、仅 MA5/MA10 向上）。
- **候选股票 / Candidate_Stock**：通过全部已启用筛选条件的股票。

## Requirements

### Requirement 1: 筛选沪深主板当日股票

**User Story:** 作为使用者，我希望筛选范围仅限沪深主板股票，以便排除创业板、科创板、北交所等不符合投资偏好的板块。

#### Acceptance Criteria

1. WHEN 筛选服务开始执行，THE Screening_Service SHALL 通过 `stock_basic` 接口以 `list_status`="L" 获取上市股票列表作为候选全集。
2. THE Screening_Service SHALL 仅保留 `market` 字段严格等于"主板"的股票。
3. THE Screening_Service SHALL 仅保留代码前缀属于沪市 600、601、603、605 或深市 000、001、002 的股票，其余前缀一律排除。
4. IF 股票代码前缀属于创业板 300/301、科创板 688/689 或北交所 8/4 开头，THEN THE Screening_Service SHALL 将该股票从候选集中排除，且排除规则相对保留规则具有绝对优先级（同时命中保留与排除条件时以排除为准）。
5. THE Screening_Service SHALL 将基准日确定为：从当前自然日向前回溯、已过 15:00 收盘时刻，且 `daily` 与 `daily_basic` 均可查询到非空数据的最近交易日，回溯上限为 7 个交易日。
6. IF `stock_basic` 接口调用失败、超时或返回空列表，THEN THE Screening_Service SHALL 中止本次筛选并返回指示股票列表获取失败的错误。
7. IF 回溯 7 个交易日后仍无满足条件的可用基准日，THEN THE Screening_Service SHALL 中止本次筛选并返回指示无可用基准日的错误。

### Requirement 2: 按当日涨幅筛选

**User Story:** 作为使用者，我希望只保留当日涨幅在 3% 到 5% 区间的股票，以便聚焦温和上涨的标的。

#### Acceptance Criteria

1. WHEN 筛选服务执行涨幅筛选，THE Screening_Service SHALL 通过 `daily` 接口获取基准日的当日涨幅 `pct_chg`（单位：百分比，如 3.5 表示 3.5%）。
2. WHERE 股票当日 `pct_chg` 为有效数值且满足 3 ≤ pct_chg ≤ 5（含端点 3 与 5），THE Screening_Service SHALL 将该股票保留在候选集中。
3. IF 股票当日 `pct_chg` 为有效数值且小于 3 或大于 5，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
4. IF 某股票在基准日缺少 `daily` 数据，或 `pct_chg` 为空、null 或非有效数值，THEN THE Screening_Service SHALL 将该股票从候选集中排除并记录该情况；即使记录操作失败，THE Screening_Service SHALL 仍执行排除。

### Requirement 3: 按量比筛选

**User Story:** 作为使用者，我希望只保留量比大于等于 1 的股票，以便筛选出当日放量的标的。

#### Acceptance Criteria

1. WHEN 筛选服务执行量比筛选，THE Screening_Service SHALL 通过 `daily_basic` 接口获取基准日（沿用需求 1 定义）的量比 `volume_ratio`（大于 0 的浮点数）。
2. WHERE 股票当日 `volume_ratio` 为有效数值且满足 volume_ratio ≥ 1（含端点 1），THE Screening_Service SHALL 将该股票保留在候选集中。
3. IF 股票当日 `volume_ratio` 为有效数值且小于 1，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
4. IF 某股票在基准日的 `volume_ratio` 字段缺失、为空、为 null 或为非有效数值，THEN THE Screening_Service SHALL 将该股票从候选集中排除并记录该情况；即使记录操作失败，THE Screening_Service SHALL 仍执行排除。

### Requirement 4: 按换手率筛选

**User Story:** 作为使用者，我希望只保留换手率在 5% 到 10% 区间的股票，以便筛选出交投活跃度适中的标的。

#### Acceptance Criteria

1. WHEN 筛选流程针对某一基准日启动，THE Screening_Service SHALL 通过 `daily_basic` 接口获取该基准日全部候选股票的换手率 `turnover_rate`（单位：百分比，取值范围 0 至 100）。
2. WHERE 股票当日 `turnover_rate` 满足 5 ≤ turnover_rate ≤ 10（含端点），THE Screening_Service SHALL 将该股票保留在候选集中。
3. IF 股票当日 `turnover_rate` 小于 5 或大于 10，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
4. IF 某股票在基准日缺少 `turnover_rate` 数据（字段为 null、空值或未返回），THEN THE Screening_Service SHALL 将该股票从候选集中排除，并记录一条包含该股票代码与缺失原因的诊断日志。
5. IF `daily_basic` 接口调用失败或在 10 秒内未返回数据，THEN THE Screening_Service SHALL 最多重试 3 次；重试均失败后，THE Screening_Service SHALL 中止本次换手率筛选、保留调用前的候选集不做修改，并返回指示换手率数据获取失败的错误。

### Requirement 5: 按流通市值筛选

**User Story:** 作为使用者，我希望只保留流通市值在 50 亿到 200 亿之间的股票，以便聚焦中盘规模的标的。

#### Acceptance Criteria

1. WHEN 筛选流程针对某一基准日启动，THE Screening_Service SHALL 通过 `daily_basic` 接口获取该基准日的流通市值 `circ_mv`（单位：万元）。
2. WHERE 股票当日 `circ_mv` 为有效数值且满足 500000 ≤ circ_mv ≤ 2000000（万元，含两端端点），THE Screening_Service SHALL 将该股票保留在候选集中。
3. IF 股票当日 `circ_mv` 为有效数值且小于 500000 或大于 2000000（万元），THEN THE Screening_Service SHALL 将该股票从候选集中排除。
4. IF 某股票在基准日的 `circ_mv` 字段为空、为 null 或无当日记录，THEN THE Screening_Service SHALL 将该股票从候选集中排除并记录该情况；即使记录操作失败，THE Screening_Service SHALL 仍执行排除。
5. IF `daily_basic` 接口调用失败或在 30 秒内未返回响应，THEN THE Screening_Service SHALL 中止本次流通市值筛选、保留调用前的候选集不做修改，并返回指示流通市值数据获取失败的错误。

### Requirement 6: 按成交量递增筛选（分级）

**User Story:** 作为使用者，我希望筛选成交量呈递增趋势的股票，并区分严格递增与非严格递增两级，以便识别持续放量的标的。

#### Acceptance Criteria

1. THE Screening_Service SHALL 通过 `daily` 接口获取每只股票截至基准日、按交易日先后顺序排列的最近三个交易日成交量 `vol`，记为前日成交量 vol1、昨日成交量 vol2、今日成交量 vol3（vol3 对应基准日）。
2. IF 股票满足 vol1 < vol2 < vol3（严格递增），THEN THE Screening_Service SHALL 将该股票保留在候选集中，并仅标注为满足成交量递增的理想条件，不标注放宽条件。
3. IF 股票满足 vol1 ≤ vol2 ≤ vol3（非严格递增，允许相等）但不满足严格递增，THEN THE Screening_Service SHALL 将该股票保留在候选集中，并标注为满足成交量递增的放宽条件，不标注理想条件。
4. IF 股票不满足 vol1 ≤ vol2 ≤ vol3，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
5. IF 某股票最近三个交易日的 `vol` 数据不足三条，或其中存在缺失或小于等于 0 的成交量值，THEN THE Screening_Service SHALL 将该股票从候选集中排除，并生成一条包含股票代码与排除原因的可查询排除记录；即使记录操作失败，THE Screening_Service SHALL 仍执行排除。

### Requirement 7: 按均线趋势筛选（分级）

**User Story:** 作为使用者，我希望筛选均线向上的股票，优先多头排列，其次至少 5 日、10 日均线向上，以便识别趋势向好的标的。

#### Acceptance Criteria

1. WHERE 某股票拥有至少 61 个交易日的历史 `close` 数据，THE Screening_Service SHALL 使用该数据计算基准日与前一交易日的 MA5、MA10、MA20、MA60。
2. THE Screening_Service SHALL 依据"当日均线值严格大于前一交易日均线值"判定每条均线向上；当两值相等或当日均线值小于前一交易日均线值时，判定该均线不向上。
3. WHERE 股票在基准日满足 MA5 > MA10 > MA20 > MA60 且 MA5、MA10、MA20、MA60 四条均线均向上，THE Screening_Service SHALL 将该股票仅标注为满足均线趋势的理想条件（多头排列），不再同时标注放宽条件。
4. WHERE 股票不满足多头排列但满足 MA5 向上且 MA10 向上，THE Screening_Service SHALL 将该股票标注为满足均线趋势的放宽条件。
5. IF 股票不满足 MA5 向上或不满足 MA10 向上，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
6. IF 某股票历史 `close` 数据少于 61 个交易日，THEN THE Screening_Service SHALL 跳过多头排列判定，仅按 MA5 向上且 MA10 向上的放宽条件评估该股票。
7. IF 某股票历史 `close` 数据少于 11 个交易日（不足以计算基准日与前一交易日的 MA10），THEN THE Screening_Service SHALL 将该股票从候选集中排除，并标注为数据不足而无法评估。

### Requirement 8: 分时数据比较（依赖分钟权限，当前不实现）

**User Story:** 作为使用者，我希望筛选分时走势强于大盘的股票，以便识别盘中相对强势的标的。

#### Acceptance Criteria

1. WHERE 分钟权限已开通，THE Screening_Service SHALL 通过 `stk_mins` 获取个股分时数据，并通过 `idx_mins` 获取对应大盘指数分时数据（沪市股票对应上证指数，深市股票对应深证成指），且个股与指数使用相同分钟频率与相同交易时段（09:30–11:30、13:00–15:00）。
2. WHERE 分钟权限已开通，THE Screening_Service SHALL 将个股与指数分别换算为以各自当日开盘价为基准的涨跌幅百分比，仅对双方均存在数据的对齐时间点进行比较。
3. WHERE 分钟权限已开通，THE Screening_Service SHALL 计算占比 = 个股涨跌幅大于等于同一时刻大盘涨跌幅的有效对齐时间点数量 / 有效对齐时间点总数。
4. WHERE 分钟权限已开通且该占比大于等于 50%（0.50），THE Screening_Service SHALL 将该股票保留在候选集中。
5. IF 分钟权限已开通但该占比小于 50%，THEN THE Screening_Service SHALL 将该股票从候选集中排除。
6. IF 分钟权限未开通，或分时数据缺失、接口失败、有效对齐时间点数量为 0，THEN THE Screening_Service SHALL 跳过需求 8 的判定、不因该需求排除任何股票，并在数据异常时记录提示信息。

> 说明：本需求依赖单独的"分钟权限"，用户当前【未开通】。因此本需求在当前版本作为可选后续模块，仅在权限开通后接入，不阻塞需求 1–7 的筛选流程。

### Requirement 9: 结果输出

**User Story:** 作为前端使用者，我希望通过现有接口获取筛选结果，以便在"今日推荐"页面展示候选股票。

#### Acceptance Criteria

1. WHEN 前端请求 `GET /api/daily-recommendations`，THE Recommendation_API SHALL 触发筛选服务并返回通过需求 1 至需求 7 全部已启用筛选条件的候选股票列表（需求 8 因分钟权限未开通不启用）。
2. THE Recommendation_API SHALL 在返回的每只候选股票中包含股票代码、名称、需求 6 的成交量分级标注（取值为"理想条件"或"放宽条件"）以及需求 7 的均线分级标注（取值为"理想条件"或"放宽条件"）。
3. THE Recommendation_API SHALL 沿用现有响应格式 `{ code, data }`，成功时 code 为整数 0，data 为候选股票数组，其元素数量范围为 0 至沪深主板股票总数。
4. WHERE 无任何股票通过筛选，THE Recommendation_API SHALL 返回 code 0 及长度为 0 的 data 列表，而非返回错误。
5. IF 筛选过程发生错误，THEN THE Recommendation_API SHALL 返回 code 为 -1 及包含失败原因的描述性错误信息、使用 HTTP 500 状态码，并且不返回任何部分筛选结果。

### Requirement 10: 数据获取与调用约束

**User Story:** 作为使用者，我希望系统在账号权限范围内稳定获取数据，以便筛选流程不因权限或调用频率问题失败。

#### Acceptance Criteria

1. THE Screening_Service SHALL 通过 Tushare_Client（`callTushare`）调用 `daily`、`daily_basic` 及 `stock_basic` 接口获取所需数据。
2. THE Screening_Service SHALL 仅使用收盘后入库的当日及历史数据。
3. THE Screening_Service SHALL NOT 调用任何实时 `rt_*` 接口。
4. IF Tushare 接口返回错误，或单次调用在 30 秒内未返回响应，THEN THE Screening_Service SHALL 中止本次筛选、不返回任何部分筛选结果，并返回包含失败接口名称与失败原因的错误信息。
5. WHERE 某次接口调用因瞬时错误（网络抖动、超时）失败，THE Screening_Service SHALL 最多重试 3 次，且相邻重试间隔至少 1 秒。
6. IF 某接口因账号权限不足而调用失败，THEN THE Screening_Service SHALL 不对该接口重试，中止本次筛选，并返回指示权限不足及对应接口名称的错误信息。
