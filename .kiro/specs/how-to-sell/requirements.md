# Requirements Document

## Introduction

本功能（how-to-sell，"我的股票合适卖"）为持仓用户提供一个**半自动止盈止损系统**，页面挂载在路由 `/how-to-sell` 下。用户录入持仓信息（股票代码、成本价、持仓数量、可选买入日期）后，系统基于 Tushare Pro 历史日线行情，动态计算成本止损位、趋势判断、移动止盈线、分批止盈目标、成交量确认，并汇总为一个 0–100 分的股票健康评分，最终给出结构化的卖出建议，通过 antd 表格（Table）展示。

系统定位是"辅助决策"而非"简单报价"：不只告诉用户"涨到多少卖"，而是分层给出保护本金、锁定利润、跟随趋势的完整策略。

关键前提与约束：

- 全部基于 Tushare Pro 收盘后入库的历史日线行情（`daily` / `pro_bar`），不使用任何实时 `rt_*` 接口。
- 复用现有 Tushare 调用封装 `src/apis/_tushare.ts` 中的 `callTushare`，并参考现有筛选功能（`src/apis/screening/`）的数据获取、错误处理与纯函数计算分层方式。
- 前端使用 antd v6、React 19、react-router-dom v7，与现有页面（`src/pages/TodaysRecommendation.tsx`）保持一致的技术栈。

### V1 范围界定

- ✅ 纳入 V1：Tushare 历史行情获取、MA5/MA10/MA20/MA60 计算、ATR(14) 动态止损、移动止盈、分批止盈、成交量确认、健康评分与建议、antd 表格展示。
- ❌ 不在 V1：微信 / 邮件提醒、复杂量化因子、盘中实时监控、持仓数据持久化。相关需求若出现，均标注为后续版本，不阻塞 V1。

## Glossary

- **卖出策略服务 / Sell_Advisor_Service**：本功能的后端计算逻辑，接收持仓输入、拉取历史行情、执行分层策略与评分，返回卖出建议结构。
- **卖出建议接口 / Sell_Advice_API**：后端 HTTP 接口，接收持仓表单参数并返回策略计算结果（沿用项目 `{ code, data }` 响应格式）。
- **何时卖页面 / How_To_Sell_Page**：路由 `/how-to-sell` 下的前端页面，负责录入表单与展示策略结果表格。
- **Tushare_Client**：封装 Tushare Pro HTTP 调用的模块（`src/apis/_tushare.ts` 中的 `callTushare` 函数）。
- **持仓输入 / Position_Input**：用户提交的持仓信息，包含股票代码 code、成本价 cost、持仓数量 position、可选买入日期 buy_date。
- **股票代码 / code**：6 位数字的沪深主板证券代码（用户仅输入 6 位纯数字，不含交易所后缀），系统据前缀自动补全交易所后缀（6 开头→.SH，0 开头→.SZ）。
- **可识别沪深主板前缀 / Recognizable_Prefix**：能被映射到交易所后缀的 6 位数字代码前缀——以 `6` 开头（如 600/601/603/605）映射为 `.SH`（上交所），以 `0` 开头（如 000/001/002/003）映射为 `.SZ`（深交所）。
- **完整代码 / full_code**：由 6 位数字 code 经交易所后缀补全后得到的带后缀完整证券代码（如 `600000.SH`、`000001.SZ`），用于调用 Tushare 接口。
- **成本价 / cost**：用户建仓的每股平均成本，单位为元，取值大于 0。
- **持仓数量 / position**：用户持有的股份数，单位为股，取值为大于 0 的整数。
- **买入日期 / buy_date**：用户建仓日期，格式 YYYYMMDD，为可选字段。
- **当前价 / current_price**：所取历史行情中最近一个有效交易日的收盘价 `close`。
- **盈亏比例 / profit_pct**：`(current_price - cost) / cost × 100`，单位为百分比，正值表示盈利。
- **日线行情 / Daily_Bar**：Tushare `daily` / `pro_bar` 返回的单个交易日 OHLCV 数据，含开盘价 open、最高价 high、最低价 low、收盘价 close、成交量 vol。
- **有效交易日 / Valid_Trading_Day**：open、high、low、close、vol 均非空、且 close 为大于 0 的数值的交易日。
- **移动平均线 / MA**：由收盘价计算的 N 日简单移动平均值，涉及 MA5、MA10、MA20、MA60。
- **真实波幅 / TR**：单个交易日的 True Range，等于 `max(high - low, |high - prevClose|, |low - prevClose|)`。
- **ATR14 / ATR**：最近 14 个交易日 TR 的算术平均值（平均真实波幅），用于度量波动率。
- **固定止损位 / fixed_stop_loss**：`cost × 0.93`，即成本下方 7% 的硬止损价。
- **ATR 止损位 / atr_stop_loss**：`cost - ATR14 × 2`，基于波动率的动态止损价。
- **推荐止损位 / stop_loss**：系统对外输出的生效止损价，取固定止损位与 ATR 止损位中的较高者（更早触发、更保护本金）。
- **持有期最高价 / highest_price**：持有期内出现的最高收盘价 close；提供 buy_date 时取买入日至今的最高价，未提供时取所取历史区间内的最高价。
- **移动止盈线 / trailing_stop**：`highest_price × (1 - 回撤比例)`，回撤比例由健康评分档位决定（8% 或 5%）。
- **分批止盈目标 / take_profit**：基于成本价的分批减仓价位数组，每项含目标价 price、建议卖出比例 ratio、说明 reason。
- **健康评分 / health_score**：0–100 的整数评分，由趋势、价格、成交量、资金、风险五个维度加权求和得出。
- **卖出建议 / suggestion**：系统给出的最终动作建议，取值为"持有""继续观察""减仓""卖出"之一。

## Requirements

### Requirement 1: 持仓输入与校验

**User Story:** 作为持仓用户，我希望录入股票代码、成本价、持仓数量和可选买入日期，以便系统据此计算卖出策略。

#### Acceptance Criteria

1. THE How_To_Sell_Page SHALL 提供股票代码 code、成本价 cost、持仓数量 position 三个必填输入项与买入日期 buy_date 一个可选输入项，其中 code 输入项仅接受 6 位纯数字（沪深主板代码），不要求也不接受用户输入 `.SH` / `.SZ` 等交易所后缀。
2. WHEN 用户提交表单且 code、cost、position 三项均已填写并通过校验，THE How_To_Sell_Page SHALL 调用 Sell_Advice_API 发起策略计算。
3. IF code 为空、不是 6 位数字、或不属于沪深主板可识别前缀（无法映射到 .SH/.SZ），THEN THE How_To_Sell_Page SHALL 阻止提交、提示"请输入 6 位沪深主板股票代码"并保留用户已输入的其它字段值。
4. IF cost 为空、非数值、小于 0.01、大于 999999.99 或小数位超过 2 位，THEN THE How_To_Sell_Page SHALL 阻止提交、提示成本价必须为 0.01 至 999999.99 之间且最多两位小数的数值并保留用户已输入的其它字段值。
5. IF position 为空、非整数、小于 1 或大于 9999999999，THEN THE How_To_Sell_Page SHALL 阻止提交、提示持仓数量必须为 1 至 9999999999 之间的整数并保留用户已输入的其它字段值。
6. WHERE 用户填写了 buy_date，IF 其不是格式为 YYYYMMDD 的合法日期、早于 19901219 或晚于当前自然日，THEN THE How_To_Sell_Page SHALL 阻止提交、提示买入日期无效并保留用户已输入的其它字段值。
7. WHERE 用户未填写 buy_date，THE Sell_Advisor_Service SHALL 以所取历史行情区间的起始交易日作为持有期起点计算持有期最高价。
8. IF Sell_Advice_API 在 10 秒内未返回或返回错误，THEN THE How_To_Sell_Page SHALL 终止计算、提示请求失败并保留表单已输入内容以便用户重试。
9. WHEN code 通过校验（为 6 位数字且属于可识别沪深主板前缀），THE How_To_Sell_Page 或 Sell_Advisor_Service SHALL 依据 6 位数字前缀自动补全交易所后缀得到完整代码 full_code：以 `6` 开头（如 600/601/603/605）补 `.SH`（上交所），以 `0` 开头（如 000/001/002/003）补 `.SZ`（深交所）。
10. IF code 的 6 位数字前缀既非 `6` 开头也非 `0` 开头（无法映射到 .SH/.SZ），THEN THE How_To_Sell_Page SHALL 阻止提交、提示"请输入 6 位沪深主板股票代码"并保留用户已输入的其它字段值。

### Requirement 2: 历史行情获取

**User Story:** 作为持仓用户，我希望系统基于真实历史行情计算策略，以便结果可靠。

#### Acceptance Criteria

1. WHEN Sell_Advisor_Service 收到合法持仓输入，THE Sell_Advisor_Service SHALL 使用由 6 位数字 code 补全交易所后缀后得到的完整代码 full_code，通过 Tushare_Client 调用 `daily` 或 `pro_bar` 获取截至最近交易日、按 trade_date 升序排列的历史日线行情，且每条记录包含 trade_date、open、high、low、close、vol 字段。
2. THE Sell_Advisor_Service SHALL 请求覆盖至少 75 个交易日的历史区间，以满足 MA60（需 60 日）与 ATR14（需额外 14 日）的计算需要。
3. THE Sell_Advisor_Service SHALL 将 open、high、low、close、vol 均非空、且 close 为大于 0 的数值的交易日定义为有效交易日。
4. WHEN 历史行情中存在至少一个有效交易日，THE Sell_Advisor_Service SHALL 将其中 trade_date 最大（最近）的有效交易日的 close 作为当前价 current_price。
5. IF 该 code 的历史行情返回为空、或有效交易日少于 60 个，THEN THE Sell_Advisor_Service SHALL 中止计算并返回指示历史数据不足的错误，且不返回任何部分结果。
6. IF Tushare 接口单次调用失败或在 30 秒内未返回响应，THEN THE Sell_Advisor_Service SHALL 最多重试 3 次且相邻重试间隔至少 1 秒；在 3 次重试均失败后 SHALL 返回包含失败接口名称与失败原因的错误，且不返回任何部分结果。
7. THE Sell_Advisor_Service SHALL NOT 调用任何实时 `rt_*` 接口。

### Requirement 3: 盈亏计算

**User Story:** 作为持仓用户，我希望看到当前盈亏，以便快速了解持仓状态。

#### Acceptance Criteria

1. WHEN 接收到有效的 current_price 与 cost（两者均为数值且 cost 大于 0），THE Sell_Advisor_Service SHALL 按 `profit_pct = (current_price - cost) / cost × 100` 计算盈亏比例，并采用四舍五入保留两位小数。
2. THE Sell_Advisor_Service SHALL 在输出中包含 current_price、cost 与 profit_pct 三个字段，其中 current_price 与 cost 的取值范围为 0.01 至 999999999.99，profit_pct 保留两位小数。
3. WHERE current_price 大于等于 cost，THE Sell_Advisor_Service SHALL 使 profit_pct 为非负值；WHERE current_price 小于 cost，THE Sell_Advisor_Service SHALL 使 profit_pct 为负值。
4. IF cost 小于等于 0，THEN THE Sell_Advisor_Service SHALL 跳过盈亏计算，不输出 profit_pct 字段，并返回指示成本无效的错误标识。
5. IF current_price 或 cost 缺失或非数值，THEN THE Sell_Advisor_Service SHALL 拒绝该计算请求，不输出 profit_pct 字段，并返回指示输入无效的错误标识。

### Requirement 4: 第一层——成本止损（保护本金）

**User Story:** 作为持仓用户，我希望系统给出保护本金的止损位，以便在方向判断错误时及时离场。

#### Acceptance Criteria

1. WHERE cost（用户持仓成本单价，单位：元）为大于 0 的数值，THE Sell_Advisor_Service SHALL 按 `fixed_stop_loss = cost × 0.93` 计算固定止损位，并对结果四舍五入保留 2 位小数（精确到 0.01 元）。
2. THE Sell_Advisor_Service SHALL 按 `TR = max(high - low, |high - prevClose|, |low - prevClose|)` 计算每个交易日的真实波幅，并按最近 14 个交易日 TR 的算术平均计算 ATR14，其中 high、low、prevClose 取自日线行情数据，计算结果四舍五入保留 4 位小数。
3. THE Sell_Advisor_Service SHALL 按 `atr_stop_loss = cost - ATR14 × 2` 计算 ATR 动态止损位，并对结果四舍五入保留 2 位小数（精确到 0.01 元）。
4. THE Sell_Advisor_Service SHALL 将推荐止损位 stop_loss 取为 fixed_stop_loss 与 atr_stop_loss 中的较大者（当两者相等时取该相等值），并在输出中同时包含 fixed_stop_loss、atr_stop_loss 与 stop_loss 三个字段，三者均为精确到 0.01 元的数值。
5. IF 可用于计算 ATR14 的交易日少于 15 个（14 日 TR 需相邻日收盘价），THEN THE Sell_Advisor_Service SHALL 将 atr_stop_loss 置为 null，并将 stop_loss 取为 fixed_stop_loss。
6. IF current_price（最新成交价，单位：元）小于等于 stop_loss，THEN THE Sell_Advisor_Service SHALL 在输出中将成本止损触发标记字段置为 true；否则置为 false。
7. IF cost 缺失或小于等于 0，THEN THE Sell_Advisor_Service SHALL 将 fixed_stop_loss、atr_stop_loss 与 stop_loss 三个字段均置为 null，并在输出中返回一条指示成本无效的错误标记，同时不修改其他已计算字段。

### Requirement 5: 第二层——趋势判断

**User Story:** 作为持仓用户，我希望系统判断当前趋势强弱，以便决定继续持有还是减仓。

#### Acceptance Criteria

1. WHEN 存在至少 60 个有效交易日，THE Sell_Advisor_Service SHALL 使用最近 60 个交易日的收盘价计算最近交易日的 MA5、MA10、MA20、MA60，各值四舍五入保留 2 位小数。
2. IF current_price > MA5 且 MA5 > MA20 且 MA20 > MA60，THEN THE Sell_Advisor_Service SHALL 判定为强趋势并将趋势状态标记为"强势"。
3. IF current_price < MA20 且 MA5 < MA20，THEN THE Sell_Advisor_Service SHALL 判定短期趋势转坏、将趋势状态标记为"转坏"并标记触发减仓 50%。
4. IF 既不满足强趋势条件（需求 5.2）也不满足短期趋势转坏条件（需求 5.3），THEN THE Sell_Advisor_Service SHALL 将趋势状态标记为"中性"。
5. IF 有效交易日少于 60 个而无法计算 MA60，THEN THE Sell_Advisor_Service SHALL 将趋势状态标记为"数据不足"并返回指示历史数据不足的错误。
6. THE Sell_Advisor_Service SHALL 在输出中包含 MA5、MA10、MA20、MA60 的数值与趋势状态标记，且趋势状态标记取值为"强势""转坏""中性""数据不足"之一。

### Requirement 6: 第三层——移动止盈（核心）

**User Story:** 作为持仓用户，我希望系统跟踪持有期最高价并给出回撤止盈线，以便在趋势见顶回落时锁定利润。

#### Acceptance Criteria

1. WHEN 持有期区间内存在有效收盘价，THE Sell_Advisor_Service SHALL 计算持有期最高价 highest_price：提供 buy_date 时取买入日（含）至最近交易日区间内的最高收盘价 close，未提供时取所取历史区间内的最高收盘价 close，并四舍五入保留 2 位小数。
2. THE Sell_Advisor_Service SHALL 按 `trailing_stop = highest_price × (1 - 回撤比例)` 计算移动止盈线并四舍五入保留 2 位小数，其中回撤比例依据需求 9 的评分档位取 0.08（80 ≤ health_score ≤ 100）或 0.05（60 ≤ health_score < 80）。
3. THE Sell_Advisor_Service SHALL 在输出中包含 highest_price 与 trailing_stop 两个字段。
4. IF 持有期区间内无有效收盘价，THEN THE Sell_Advisor_Service SHALL 不计算移动止盈线并将 highest_price 与 trailing_stop 置为 null 以标记不可用。
5. IF highest_price 与 trailing_stop 均可用且 current_price 小于等于 trailing_stop，THEN THE Sell_Advisor_Service SHALL 将移动止盈触发标记字段置为 true；否则置为 false。

### Requirement 7: 第四层——分批止盈

**User Story:** 作为持仓用户，我希望系统给出分批止盈的价位与比例，以便逐步锁定利润同时让部分仓位跟随趋势。

#### Acceptance Criteria

1. WHEN 用户传入的 cost 为大于 0 的有效数值，THE Sell_Advisor_Service SHALL 输出包含两档的分批止盈目标数组 take_profit：第一档目标价为 `cost × 1.20`、建议卖出比例 30%、reason 为"盈利 20% 锁定利润"；第二档目标价为 `cost × 1.40`、建议卖出比例 40%、reason 为"盈利 40% 继续减仓"。
2. THE Sell_Advisor_Service SHALL 使 take_profit 数组中每一项均包含 price、ratio、reason 三个字段，且 price 为保留两位小数的数值、ratio 为 0 到 1 之间（或等值百分比）的数值。
3. THE Sell_Advisor_Service SHALL 在输出中标注两档止盈后仍保留 30% 仓位让利润奔跑。
4. IF current_price 为有效数值且大于等于某一档目标价，THEN THE Sell_Advisor_Service SHALL 将该档标记为已达到；IF current_price 缺失或无效，THEN THE Sell_Advisor_Service SHALL 不将任何档位标记为已达到。
5. IF cost 缺失、非数值或小于等于 0，THEN THE Sell_Advisor_Service SHALL 不输出 take_profit 目标数组，并返回指示 cost 无效的错误信息，同时不改变其他输出字段。

### Requirement 8: 第五层——成交量确认

**User Story:** 作为持仓用户，我希望系统结合成交量确认上涨的有效性，以便识别缩量上涨的风险。

#### Acceptance Criteria

1. WHEN 存在最近交易日与前一交易日的收盘价与成交量数据，THE Sell_Advisor_Service SHALL 按 `(最近值 - 前值) / 前值 × 100%` 分别计算价格变动百分比与成交量变动百分比。
2. IF 最近交易日价格变动百分比大于 0% 且成交量变动百分比小于 -20%，THEN THE Sell_Advisor_Service SHALL 判定为量价背离（放量不足）并在输出中标记下调移动止盈位。
3. WHERE 判定为量价背离，THE Sell_Advisor_Service SHALL 将移动止盈线的回撤比例在需求 6 结果基础上收紧 2 个百分点（回撤比例减小 0.02）使止盈线上移；IF 收紧后回撤比例小于 0%，THEN 取 0%。
4. IF 最近两个交易日中任一交易日成交量数据缺失、或有效交易日不足 2 个，THEN THE Sell_Advisor_Service SHALL 跳过量价背离判定、保留需求 6 的移动止盈结果不作调整并在输出中标记成交量确认未执行。

### Requirement 9: 健康评分模型

**User Story:** 作为持仓用户，我希望系统用 0–100 的评分量化持仓健康度，以便一眼判断该持有还是卖出。

#### Acceptance Criteria

1. THE Sell_Advisor_Service SHALL 计算健康评分 health_score，为趋势、价格、成交量、资金、风险五个维度得分之和，满分 100（趋势 30、价格 20、成交量 20、资金 20、风险 10）。
2. THE Sell_Advisor_Service SHALL 按如下规则计算趋势维度得分（0–30）：满足 current_price > MA5 > MA20 > MA60 记 30 分；满足 current_price > MA20 且 MA5 > MA20 但不满足前者记 20 分；仅满足 current_price > MA20 记 10 分；current_price ≤ MA20 记 0 分。
3. THE Sell_Advisor_Service SHALL 按如下规则计算价格维度得分（0–20）：profit_pct ≥ 20 记 20 分；10 ≤ profit_pct < 20 记 15 分；0 ≤ profit_pct < 10 记 10 分；-7 ≤ profit_pct < 0 记 5 分；profit_pct < -7 记 0 分。
4. THE Sell_Advisor_Service SHALL 按如下规则计算成交量维度得分（0–20）：设最近三个交易日成交量依次为 V1、V2、V3，满足 V1 < V2 < V3（严格递增）记 20 分；满足 V1 ≤ V2 ≤ V3 但非严格递增记 10 分；其余记 0 分。
5. THE Sell_Advisor_Service SHALL 按如下规则计算资金维度得分（0–20）：最近交易日收盘价高于前一交易日且成交量高于前一交易日记 20 分；收盘价高于前一交易日但成交量不高于前一交易日记 10 分；收盘价不高于前一交易日（含持平与下跌）记 0 分。
6. THE Sell_Advisor_Service SHALL 按如下规则计算风险维度得分（0–10）：`(current_price - stop_loss) / current_price × 100` 大于 5 记 10 分；介于 2 与 5 之间（含端点 2 与 5）记 5 分；小于 2 记 0 分。
7. THE Sell_Advisor_Service SHALL 使 health_score 为 0 至 100 的整数，并在输出中包含各维度得分明细。
8. IF 历史数据不足以计算 MA60 或不足最近三个交易日成交量，THEN THE Sell_Advisor_Service SHALL 跳过评分、返回指示历史数据不足的错误标识并保留其余已计算结果。
9. IF stop_loss 不可用或 current_price 小于等于 0 导致风险公式无法计算，THEN THE Sell_Advisor_Service SHALL 将风险维度记 0 分并在得分明细中标注风险维度不可计算。

### Requirement 10: 综合卖出建议

**User Story:** 作为持仓用户，我希望系统汇总各层策略给出一个明确的动作建议，以便直接据此操作。

#### Acceptance Criteria

1. WHEN 各层策略计算完成并触发建议评估，THE Sell_Advisor_Service SHALL 依据 current_price、stop_loss、trailing_stop 与 health_score（0 至 100 的整数）计算 suggestion，其取值为"卖出""持有""继续观察""减仓"之一。
2. IF current_price 小于等于 stop_loss（触发成本止损）或 current_price 小于等于 trailing_stop（触发移动止盈），THEN THE Sell_Advisor_Service SHALL 将 suggestion 置为"卖出"，且该判定优先于评分档位。
3. WHERE 未触发止损或移动止盈且 80 ≤ health_score ≤ 100，THE Sell_Advisor_Service SHALL 将 suggestion 置为"持有"并将移动止盈回撤比例设为 8%。
4. WHERE 未触发止损或移动止盈且 60 ≤ health_score < 80，THE Sell_Advisor_Service SHALL 将 suggestion 置为"继续观察"并将移动止盈回撤比例设为 5%。
5. WHERE 未触发止损或移动止盈且 40 ≤ health_score < 60，THE Sell_Advisor_Service SHALL 将 suggestion 置为"减仓"。
6. WHERE 未触发止损或移动止盈且 0 ≤ health_score < 40，THE Sell_Advisor_Service SHALL 将 suggestion 置为"卖出"。
7. WHERE 需求 5.3 判定短期趋势转坏触发减仓 50% 且 suggestion 尚为"持有"或"继续观察"，THE Sell_Advisor_Service SHALL 将 suggestion 下调为"减仓"。
8. IF current_price、stop_loss、trailing_stop 或 health_score 中任一项缺失、非数值或 health_score 越出 0 至 100 范围，THEN THE Sell_Advisor_Service SHALL 不输出建议并返回指示数据不可用的错误提示。

### Requirement 11: 策略结果输出

**User Story:** 作为前端使用者，我希望通过接口获取结构化的策略结果，以便在页面上展示。

#### Acceptance Criteria

1. WHEN 前端请求 Sell_Advice_API 且携带合法持仓参数，THE Sell_Advice_API SHALL 触发 Sell_Advisor_Service 并沿用 `{ code, data }` 响应格式，在 30 秒内以 HTTP 200 返回，成功时 code 为整数 0，data 为策略结果对象。
2. THE Sell_Advice_API SHALL 使成功响应的 data 至少包含 current_price、profit_pct、suggestion、stop_loss、fixed_stop_loss、atr_stop_loss、take_profit、trailing_stop、highest_price、health_score 及各维度得分明细（含维度名称与得分）字段；其中价格类字段为大于 0 的数值，profit_pct 为可正可负的百分比数值，health_score 为 0 至 100 的整数。
3. THE Sell_Advice_API SHALL 使 suggestion 取值为"卖出""持有""继续观察""减仓"之一。
4. THE Sell_Advice_API SHALL 使 take_profit 为长度不超过 2 的数组，其每一项包含 price（大于 0 的数值）、ratio（0 至 1 之间的数值）与 reason（文本）三个字段，且各项 ratio 之和不超过 1。
5. IF 输入参数非法（未通过需求 1 校验），THEN THE Sell_Advice_API SHALL 返回 code 为 -1、包含具体校验失败原因的错误信息，并使用 HTTP 400 状态码。
6. IF 计算过程发生错误（含历史数据不足、接口失败），THEN THE Sell_Advice_API SHALL 返回 code 为 -1、包含失败原因的错误信息、使用 HTTP 500 状态码，并且不返回任何部分结果。

### Requirement 12: 表格展示

**User Story:** 作为持仓用户，我希望在页面上以表格清晰查看止损位、止盈目标、移动止盈、评分与建议，以便快速决策。

#### Acceptance Criteria

1. WHEN Sell_Advice_API 返回成功结果，THE How_To_Sell_Page SHALL 使用 antd 的 Table 组件展示策略结果，且在同一页面内无需滚动即可看到表格首行。
2. WHEN Sell_Advice_API 返回成功结果，THE How_To_Sell_Page SHALL 在结果区域展示 current_price、profit_pct、suggestion、stop_loss、trailing_stop、highest_price、health_score 各项；其中 current_price、stop_loss、trailing_stop、highest_price 保留 2 位小数，profit_pct 以百分比显示并保留 2 位小数，health_score 显示为 0 到 100 的整数。
3. WHEN Sell_Advice_API 返回成功结果且 take_profit 数组长度大于 0，THE How_To_Sell_Page SHALL 使用 antd Table 展示 take_profit 各档的目标价 price（保留 2 位小数）、卖出比例 ratio（以百分比显示并保留 2 位小数）与说明 reason。
4. IF Sell_Advice_API 返回成功结果且 take_profit 数组长度为 0，THEN THE How_To_Sell_Page SHALL 在止盈目标区域显示空数据占位提示且不渲染止盈档位行。
5. WHILE Sell_Advice_API 请求处理中，THE How_To_Sell_Page SHALL 显示加载指示器并禁用触发查询的操作控件，直至请求返回成功或错误结果。
6. IF Sell_Advice_API 请求在 10 秒内未返回结果，THEN THE How_To_Sell_Page SHALL 终止加载状态并展示超时错误提示信息且不渲染结果表格。
7. IF Sell_Advice_API 返回错误，THEN THE How_To_Sell_Page SHALL 展示错误提示信息、不渲染结果表格且保留用户已输入的查询参数。
8. WHERE suggestion 为"卖出"或"减仓"，THE How_To_Sell_Page SHALL 对建议项施加区别于"持有""继续观察"的视觉标识（如颜色标签），使两类建议在颜色上可明确区分。
