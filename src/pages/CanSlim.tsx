// CAN SLIM 选股前端页面
//
// 展示三层信息，对应规格第 19 节的输出要求：
// 1. 市场环境（M 因子）—— 决定入选门槛，用配色区分 BULL / NEUTRAL / BEAR
// 2. 候选股排名表 —— 总分 + 六因子分数，展开行显示每个因子的逐条解释
// 3. 数据状态与降级提示 —— 让用户知道哪些数据缺失、怎么补
//
// 数据流：GET /api/can-slim（默认只读本地缓存，秒级返回）。
// 财务与机构数据需要用 CLI 脚本离线预热，页面上给出命令提示。

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

const { Title, Text, Paragraph } = Typography;

// ────────────────────────────────────────────────────────────
// 类型（与后端 src/apis/can-slim/types.ts 保持一致）
// ────────────────────────────────────────────────────────────

type MarketRegime = "BULL" | "NEUTRAL" | "BEAR";
type FactorKey = "c" | "a" | "n" | "s" | "l" | "i";

interface FactorResult {
  score: number | null;
  details: string[];
  degradedReason?: string;
  metrics?: Record<string, number | string | null>;
}

interface MarketRegimeResult {
  regime: MarketRegime;
  score: number;
  indexes: {
    ts_code: string;
    name: string;
    close: number;
    maShort: number | null;
    maLong: number | null;
    regime: MarketRegime;
    note: string;
  }[];
  summary: string;
  degradedReason?: string;
}

interface BuySignal {
  entryPrice: number;
  stopLossPrice: number;
  stopLossPct: number;
  reasons: string[];
  warnings: string[];
}

interface Candidate {
  rank: number;
  ts_code: string;
  name: string;
  industry: string;
  market: string;
  close: number;
  pctChg: number;
  totalScore: number;
  factors: Record<FactorKey, FactorResult>;
  degradedFactors: { factor: FactorKey; reason: string }[];
  effectiveWeights: Record<FactorKey, number>;
  gates: { passed: Record<string, boolean>; failedReasons: string[]; allPassed: boolean };
  buySignal: BuySignal | null;
}

interface ScreeningStats {
  totalStocks: number;
  universeSize: number;
  afterRsGate: number;
  afterFinancialGate: number;
  candidates: number;
  buySignals: number;
  degradedCounts: Record<string, number>;
}

interface ScreeningData {
  needSync: boolean;
  message?: string;
  asOfDate?: string;
  market?: MarketRegimeResult;
  scoreThreshold?: number;
  candidates?: Candidate[];
  industries?: { industry: string; medianRs: number; percentile: number; count: number }[];
  stats?: ScreeningStats;
  warnings?: string[];
  coverage?: {
    dailyRows: number;
    dailyMinDate: string | null;
    dailyMaxDate: string | null;
  };
}

type ApiResponse =
  | { code: 0; data: ScreeningData; logs?: string[] }
  | { code: -1; message: string; logs?: string[] };

// ────────────────────────────────────────────────────────────
// 常量与展示辅助
// ────────────────────────────────────────────────────────────

/** 因子展示顺序：按 CAN SLIM 字母序，而非内部的成本执行顺序 */
const FACTOR_ORDER: FactorKey[] = ["c", "a", "n", "s", "l", "i"];

const FACTOR_LABELS: Record<FactorKey, { short: string; full: string; tip: string }> = {
  c: { short: "C", full: "当季盈利", tip: "最近季度盈利增长与加速度（Current Quarterly Earnings）" },
  a: { short: "A", full: "年度盈利", tip: "3 年 EPS 复合增长、连续增长与 ROE（Annual Earnings）" },
  n: { short: "N", full: "新高突破", tip: "距 52 周高点位置与放量突破（New High）" },
  s: { short: "S", full: "供需", tip: "量价关系、换手率、流通盘与筹码集中度（Supply & Demand）" },
  l: { short: "L", full: "领导地位", tip: "全市场相对强度 RS 与行业强度（Leader or Laggard）" },
  i: { short: "I", full: "机构参与", tip: "机构家数与持股比例变化、北向资金（Institutional Sponsorship）" },
};

const REGIME_META: Record<MarketRegime, { color: string; label: string; advice: string }> = {
  BULL: { color: "green", label: "多头 BULL", advice: "可正常执行选股" },
  NEUTRAL: { color: "gold", label: "中性 NEUTRAL", advice: "只取高分标的并降低仓位" },
  BEAR: { color: "red", label: "空头 BEAR", advice: "不产生买入信号，仅作观察" },
};

/** 分数配色：越高越绿，越低越红 */
function scoreColor(score: number | null): string {
  if (score === null) return "#bfbfbf";
  if (score >= 85) return "#389e0d";
  if (score >= 70) return "#7cb305";
  if (score >= 55) return "#d4b106";
  if (score >= 40) return "#d46b08";
  return "#cf1322";
}

/** 因子分数单元格：降级时显示灰色「—」并给出原因 */
function FactorCell({ result }: { result: FactorResult | undefined }) {
  if (!result || result.score === null) {
    return (
      <Tooltip title={result?.degradedReason ?? "数据不可用，该因子不参与总分"}>
        <Text type="secondary">—</Text>
      </Tooltip>
    );
  }
  return (
    <Text strong style={{ color: scoreColor(result.score) }}>
      {result.score.toFixed(0)}
    </Text>
  );
}

// ────────────────────────────────────────────────────────────
// 页面
// ────────────────────────────────────────────────────────────

export function CanSlim() {
  const [data, setData] = useState<ScreeningData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [date, setDate] = useState<Dayjs | null>(null);

  const fetchScreening = useCallback(
    async (targetDate?: Dayjs | null) => {
      setLoading(true);
      setError(null);
      setLogs([]);
      try {
        const params = new URLSearchParams();
        if (targetDate) params.set("date", targetDate.format("YYYYMMDD"));
        const url = `/api/can-slim${params.toString() ? `?${params}` : ""}`;

        const res = await fetch(url);
        const json: ApiResponse = await res.json();
        setLogs(json.logs ?? []);
        console.log("[can-slim] 完整响应：", json);

        if (json.code === 0) {
          setData(json.data);
        } else {
          setError(json.message || "选股失败");
          setData(null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setData(null);
        console.error("[can-slim] 请求失败：", err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // 首次进入自动加载最近可用交易日的结果
  useEffect(() => {
    void fetchScreening(null);
  }, [fetchScreening]);

  const candidates = data?.candidates ?? [];
  const market = data?.market;
  const stats = data?.stats;

  const columns: TableColumnsType<Candidate> = [
    {
      title: "排名",
      dataIndex: "rank",
      width: 58,
      fixed: "left",
      render: (rank: number) => <Text strong>#{rank}</Text>,
    },
    {
      title: "股票",
      key: "stock",
      width: 172,
      fixed: "left",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Space size={4}>
            <Text strong>{r.name}</Text>
            {r.buySignal && <Tag color="green">买入信号</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.ts_code} · {r.industry}
          </Text>
        </Space>
      ),
    },
    {
      title: "收盘价",
      key: "close",
      width: 96,
      align: "right",
      sorter: (a, b) => a.close - b.close,
      render: (_, r) => (
        <Space orientation="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <Text>{r.close.toFixed(2)}</Text>
          <Text
            style={{ fontSize: 12, color: r.pctChg >= 0 ? "#cf1322" : "#389e0d" }}
          >
            {r.pctChg >= 0 ? "+" : ""}
            {r.pctChg.toFixed(2)}%
          </Text>
        </Space>
      ),
    },
    {
      title: "综合评分",
      dataIndex: "totalScore",
      width: 116,
      align: "center",
      defaultSortOrder: "descend",
      sorter: (a, b) => a.totalScore - b.totalScore,
      render: (score: number) => (
        <Space orientation="vertical" size={0} style={{ width: "100%" }}>
          <Text strong style={{ fontSize: 16, color: scoreColor(score) }}>
            {score.toFixed(1)}
          </Text>
          <Progress
            percent={score}
            showInfo={false}
            size="small"
            strokeColor={scoreColor(score)}
          />
        </Space>
      ),
    },
    // 六因子分数列
    ...FACTOR_ORDER.map<TableColumnsType<Candidate>[number]>((key) => ({
      title: (
        <Tooltip title={FACTOR_LABELS[key].tip}>
          <span>
            {FACTOR_LABELS[key].short}
            <br />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {FACTOR_LABELS[key].full}
            </Text>
          </span>
        </Tooltip>
      ),
      key,
      width: 62,
      align: "center",
      sorter: (a: Candidate, b: Candidate) =>
        (a.factors[key]?.score ?? -1) - (b.factors[key]?.score ?? -1),
      render: (_: unknown, r: Candidate) => <FactorCell result={r.factors[key]} />,
    })),
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {/* ── 标题与操作区 ── */}
        <Row justify="space-between" align="middle">
          <Col>
            <Title level={3} style={{ margin: 0 }}>
              CAN SLIM 选股
            </Title>
            <Text type="secondary">
              基于 O'Neil 七因子框架的 A 股量化近似实现
              {data?.asOfDate && ` · 基准日 ${data.asOfDate}`}
            </Text>
          </Col>
          <Col>
            <Space>
              <DatePicker
                value={date}
                onChange={setDate}
                placeholder="选择历史日期"
                disabledDate={(d) => d.isAfter(dayjs())}
                allowClear
              />
              <Button type="primary" loading={loading} onClick={() => fetchScreening(date)}>
                {loading ? "计算中…" : "执行选股"}
              </Button>
              {logs.length > 0 && (
                <Button onClick={() => setShowLogs((v) => !v)}>
                  {showLogs ? "隐藏日志" : "查看日志"}
                </Button>
              )}
            </Space>
          </Col>
        </Row>

        {error && <Alert type="error" showIcon title="选股失败" description={error} />}

        {/* ── 本地库为空的引导 ── */}
        {data?.needSync && (
          <Alert
            type="warning"
            showIcon
            title="需要先同步本地行情库"
            description={
              <Space orientation="vertical">
                <Text>{data.message}</Text>
                <Paragraph copyable={{ text: "bun run src/scripts/sync-market-data.ts" }}>
                  <Text code>bun run src/scripts/sync-market-data.ts</Text>
                </Paragraph>
              </Space>
            }
          />
        )}

        {/* ── 降级与提示 ── */}
        {data?.warnings?.map((w, i) => (
          <Alert key={i} type="info" showIcon title={w} />
        ))}

        <Spin spinning={loading}>
          {/* ── 市场环境（M 因子） ── */}
          {market && (
            <Card
              size="small"
              title={
                <Space>
                  <Text strong>市场环境（M 因子）</Text>
                  <Tag color={REGIME_META[market.regime].color}>
                    {REGIME_META[market.regime].label}
                  </Tag>
                  <Text type="secondary">综合分 {market.score}</Text>
                  <Text type="secondary">·</Text>
                  <Text type="secondary">入选门槛 {data?.scoreThreshold} 分</Text>
                </Space>
              }
              style={{ marginBottom: 16 }}
            >
              <Paragraph style={{ marginBottom: 12 }}>{market.summary}</Paragraph>
              <Row gutter={[12, 12]}>
                {market.indexes.map((idx) => (
                  <Col key={idx.ts_code} xs={24} sm={12} lg={6}>
                    <Card size="small" variant="outlined">
                      <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                        <Space>
                          <Text strong>{idx.name}</Text>
                          <Tag color={REGIME_META[idx.regime].color}>
                            {idx.regime}
                          </Tag>
                        </Space>
                        <Text style={{ fontSize: 18 }}>{idx.close.toFixed(2)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          MA50 {idx.maShort?.toFixed(1) ?? "—"} / MA200{" "}
                          {idx.maLong?.toFixed(1) ?? "—"}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {idx.note}
                        </Text>
                      </Space>
                    </Card>
                  </Col>
                ))}
              </Row>
            </Card>
          )}

          {/* ── 筛选漏斗统计 ── */}
          {stats && (
            <Card size="small" title="筛选漏斗" style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col span={4}>
                  <Statistic title="全市场" value={stats.totalStocks} suffix="只" />
                </Col>
                <Col span={4}>
                  <Statistic title="股票池" value={stats.universeSize} suffix="只" />
                </Col>
                <Col span={5}>
                  <Statistic
                    title="通过 RS 门槛"
                    value={stats.afterRsGate}
                    suffix="只"
                    styles={{ content: { color: "#1677ff" } }}
                  />
                </Col>
                <Col span={5}>
                  <Statistic
                    title="通过财务门槛"
                    value={stats.afterFinancialGate}
                    suffix="只"
                    styles={{ content: { color: "#722ed1" } }}
                  />
                </Col>
                <Col span={3}>
                  <Statistic
                    title="最终候选"
                    value={stats.candidates}
                    suffix="只"
                    styles={{ content: { color: "#389e0d" } }}
                  />
                </Col>
                <Col span={3}>
                  <Statistic
                    title="买入信号"
                    value={stats.buySignals}
                    suffix="个"
                    styles={{ content: { color: stats.buySignals > 0 ? "#cf1322" : undefined } }}
                  />
                </Col>
              </Row>
            </Card>
          )}

          {/* ── 候选股表格 ── */}
          {candidates.length > 0 ? (
            <Table<Candidate>
              rowKey="ts_code"
              columns={columns}
              dataSource={candidates}
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 860 }}
              expandable={{
                expandedRowRender: (record) => <CandidateDetail candidate={record} />,
                rowExpandable: () => true,
              }}
            />
          ) : (
            !loading &&
            !data?.needSync && (
              <Empty
                description={
                  <Space orientation="vertical">
                    <Text>当前条件下没有符合 CAN SLIM 标准的候选股</Text>
                    <Text type="secondary">
                      这在中性或空头市场是正常结果——O'Neil 的标准本身就很严格
                    </Text>
                  </Space>
                }
              />
            )
          )}

          {/* ── 行业强度 ── */}
          {data?.industries && data.industries.length > 0 && (
            <Card size="small" title="行业强度排行（按组内 RS 中位数）" style={{ marginTop: 16 }}>
              <Space size={[8, 8]} wrap>
                {data.industries.slice(0, 20).map((ind) => (
                  <Tooltip
                    key={ind.industry}
                    title={`中位 RS ${ind.medianRs} · 分位 ${ind.percentile} · ${ind.count} 只样本`}
                  >
                    <Tag color={ind.percentile >= 80 ? "green" : ind.percentile >= 60 ? "blue" : "default"}>
                      {ind.industry} {ind.medianRs}
                    </Tag>
                  </Tooltip>
                ))}
              </Space>
            </Card>
          )}

          {/* ── 执行日志 ── */}
          {showLogs && logs.length > 0 && (
            <Card size="small" title="执行日志" style={{ marginTop: 16 }}>
              <pre
                style={{
                  maxHeight: 320,
                  overflow: "auto",
                  fontSize: 12,
                  lineHeight: 1.6,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                }}
              >
                {logs.join("\n")}
              </pre>
            </Card>
          )}
        </Spin>

        {/* ── 方法论与免责说明 ── */}
        <Alert
          type="warning"
          showIcon
          title="关于本工具的定位"
          description={
            <Space orientation="vertical" size={4}>
              <Text>
                这是 CAN SLIM 思想的 A 股量化近似实现，不是对 O'Neil 原始方法的精确复刻。
                阈值（季度净利 25%、ROE 17%、RS 70 等）是来自美股统计的初始参数，尚未在 A 股回测验证。
              </Text>
              <Text>
                N 因子只覆盖「新高与突破」，新产品、新管理层等无法从行情与财报数据中可靠识别的部分未纳入。
              </Text>
              <Text type="secondary">
                结果仅供研究参考，不构成投资建议。任何买入都应设置止损。
              </Text>
            </Space>
          }
        />
      </Space>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 展开行：单只候选股的完整解释
// ────────────────────────────────────────────────────────────

function CandidateDetail({ candidate }: { candidate: Candidate }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* 买入信号 */}
      {candidate.buySignal ? (
        <Alert
          type="success"
          showIcon
          title={
            <Space wrap>
              <Text strong>买入信号</Text>
              <Text>参考价 {candidate.buySignal.entryPrice}</Text>
              <Text>
                止损价 {candidate.buySignal.stopLossPrice}（
                -{(candidate.buySignal.stopLossPct * 100).toFixed(0)}%）
              </Text>
            </Space>
          }
          description={
            <Space orientation="vertical" size={2}>
              {candidate.buySignal.reasons.map((r, i) => (
                <Text key={i} style={{ fontSize: 13 }}>
                  · {r}
                </Text>
              ))}
              {candidate.buySignal.warnings.map((w, i) => (
                <Text key={`w${i}`} type="warning" style={{ fontSize: 13 }}>
                  ⚠️ {w}
                </Text>
              ))}
            </Space>
          }
        />
      ) : (
        <Alert
          type="info"
          title="未触发买入信号，仅列入观察列表"
          description={
            candidate.gates.failedReasons.length > 0
              ? candidate.gates.failedReasons.join("；")
              : "综合评分未达当前市场环境门槛，或当日未出现放量突破"
          }
        />
      )}

      {/* 六因子逐条解释 */}
      <Row gutter={[16, 16]}>
        {FACTOR_ORDER.map((key) => {
          const f = candidate.factors[key];
          const weight = candidate.effectiveWeights[key];
          const label = FACTOR_LABELS[key];
          return (
            <Col key={key} xs={24} lg={12}>
              <Card
                size="small"
                title={
                  <Space>
                    <Tag color={f?.score === null ? "default" : "blue"}>{label.short}</Tag>
                    <Text strong>{label.full}</Text>
                    {f?.score !== null && f?.score !== undefined ? (
                      <>
                        <Text strong style={{ color: scoreColor(f.score) }}>
                          {f.score.toFixed(1)} 分
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          权重 {(weight * 100).toFixed(1)}%
                        </Text>
                      </>
                    ) : (
                      <Text type="secondary">数据不可用</Text>
                    )}
                  </Space>
                }
                style={{ height: "100%" }}
              >
                {f?.score === null ? (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {f.degradedReason ?? "该因子数据缺失，其权重已按比例摊给其余因子"}
                  </Text>
                ) : (
                  <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                    {f?.details.map((d, i) => (
                      <Text
                        key={i}
                        style={{ fontSize: 13 }}
                        type={d.startsWith("⚠️") ? "warning" : undefined}
                      >
                        · {d}
                      </Text>
                    ))}
                  </Space>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>

      {/* 基础信息 */}
      <Descriptions size="small" column={4} bordered>
        <Descriptions.Item label="代码">{candidate.ts_code}</Descriptions.Item>
        <Descriptions.Item label="行业">{candidate.industry}</Descriptions.Item>
        <Descriptions.Item label="板块">{candidate.market}</Descriptions.Item>
        <Descriptions.Item label="综合评分">
          <Text strong style={{ color: scoreColor(candidate.totalScore) }}>
            {candidate.totalScore.toFixed(1)}
          </Text>
        </Descriptions.Item>
      </Descriptions>
    </Space>
  );
}

export default CanSlim;
