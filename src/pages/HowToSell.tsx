// 我的股票合适卖（how-to-sell）前端页面
// 负责：持仓信息录入与即时校验、调用 POST /api/how-to-sell（10 秒超时）、
// 以 antd Table 展示卖出策略结果与分批止盈目标。
// 对应需求：1.1、1.2、1.3、1.8、12.1–12.8。

import { useState } from "react";
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { toFullCode } from "@/apis/sell-advisor/code";
import type {
  SellAdvice,
  Suggestion,
  TakeProfitTarget,
} from "@/apis/sell-advisor/types";

const { Title } = Typography;

// ────────────────────────────────────────────────────────────
// 接口响应类型（与后端 { code, data } / { code, message } 一致）
// ────────────────────────────────────────────────────────────
type SellAdviceResponse =
  | { code: 0; data: SellAdvice }
  | { code: -1; message: string };

/** 各字段的即时校验错误信息 */
interface FieldErrors {
  code?: string;
  cost?: string;
  position?: string;
  buyDate?: string;
}

// ────────────────────────────────────────────────────────────
// 建议视觉分类（需求 12.8）
// {"卖出","减仓"} 归为一类（醒目暖色），{"持有","继续观察"} 归为另一类（冷色），
// 两类映射到不同颜色标识，确保任一"卖出/减仓"与任一"持有/继续观察"颜色必然不同。
// ────────────────────────────────────────────────────────────

/** 建议的两大视觉类别 */
export type SuggestionCategory = "sell" | "hold";

/** 将 suggestion 归入 "sell"（卖出/减仓）或 "hold"（持有/继续观察）两类之一 */
export function classifySuggestion(suggestion: Suggestion): SuggestionCategory {
  return suggestion === "卖出" || suggestion === "减仓" ? "sell" : "hold";
}

/**
 * 返回建议对应的 antd Tag 颜色。
 * "卖出" / "减仓" 使用暖色（红 / 橙），"持有" / "继续观察" 使用冷色（绿 / 蓝），
 * 两类颜色明确区分（需求 12.8）。
 */
export function suggestionTagColor(suggestion: Suggestion): string {
  switch (suggestion) {
    case "卖出":
      return "red";
    case "减仓":
      return "orange";
    case "持有":
      return "green";
    case "继续观察":
      return "blue";
  }
}

// ────────────────────────────────────────────────────────────
// 校验与格式化工具（纯函数）
// ────────────────────────────────────────────────────────────

/** 当前自然日的 YYYYMMDD 字符串 */
function todayYYYYMMDD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 校验买入日期：合法 YYYYMMDD、且 19901219 ≤ buy_date ≤ 今日（需求 1.6） */
function isValidBuyDate(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  // 校验是否为真实存在的日历日期（排除如 20230230）
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return false;
  }
  // 同为 8 位定长字符串，可直接按字典序比较大小
  if (s < "19901219") return false;
  if (s > todayYYYYMMDD()) return false;
  return true;
}

/** 价格类数值格式化：保留 2 位小数，null/无效显示占位符 */
function fmt2(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}

export function HowToSell() {
  // 表单字段（受控，校验失败时不重置，从而保留用户输入 —— 需求 1.3–1.6、12.7）
  const [code, setCode] = useState("");
  const [cost, setCost] = useState("");
  const [position, setPosition] = useState("");
  const [buyDate, setBuyDate] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<SellAdvice | null>(null);

  /**
   * 提交前的即时校验，规则与后端保持一致（需求 1.3–1.6、1.10）。
   * 返回错误集合，为空表示全部通过。
   */
  function validateInputs(): FieldErrors {
    const errs: FieldErrors = {};

    // code：必须 6 位纯数字且可映射沪深主板后缀（首位 6 或 0）
    if (toFullCode(code.trim()) === null) {
      errs.code = "请输入 6 位沪深主板股票代码";
    }

    // cost：数值、0.01–999999.99、最多两位小数
    const costStr = cost.trim();
    if (costStr === "" || !/^\d+(\.\d{1,2})?$/.test(costStr)) {
      errs.cost = "成本价必须为 0.01 至 999999.99 之间且最多两位小数的数值";
    } else {
      const c = Number(costStr);
      if (!(c >= 0.01 && c <= 999999.99)) {
        errs.cost = "成本价必须为 0.01 至 999999.99 之间且最多两位小数的数值";
      }
    }

    // position：整数、1–9999999999
    const posStr = position.trim();
    if (posStr === "" || !/^\d+$/.test(posStr)) {
      errs.position = "持仓数量必须为 1 至 9999999999 之间的整数";
    } else {
      const p = Number(posStr);
      if (!(p >= 1 && p <= 9999999999)) {
        errs.position = "持仓数量必须为 1 至 9999999999 之间的整数";
      }
    }

    // buy_date：可选，若填写须为合法且不晚于今天的 YYYYMMDD
    const dateStr = buyDate.trim();
    if (dateStr !== "" && !isValidBuyDate(dateStr)) {
      errs.buyDate = "买入日期无效";
    }

    return errs;
  }

  /** 提交表单：校验 → 调用接口（10s 超时）→ 处理结果 */
  async function handleSubmit() {
    const errs = validateInputs();
    setFieldErrors(errs);
    // 校验失败：阻止提交，保留已输入字段值（受控 state 不变）
    if (Object.keys(errs).length > 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setAdvice(null);

    // 使用 AbortController 施加 10 秒超时（需求 1.8、12.6）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch("/api/how-to-sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          cost: Number(cost.trim()),
          position: Number(position.trim()),
          // buy_date 仅在填写时携带
          ...(buyDate.trim() ? { buy_date: buyDate.trim() } : {}),
        }),
        signal: controller.signal,
      });

      const json: SellAdviceResponse = await res.json();
      if (json.code === 0) {
        setAdvice(json.data);
      } else {
        // 请求错误：展示错误提示、不渲染结果表格、保留输入（需求 12.7）
        setError(json.message || "请求失败，请稍后重试");
        setAdvice(null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // 超时：终止加载并提示超时错误（需求 1.8、12.6）
        setError("请求超时（超过 10 秒），请稍后重试");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setAdvice(null);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  // ──────────────────────────────────────────────────────────
  // 结果表格列定义
  // ──────────────────────────────────────────────────────────

  /** 概览表列（需求 12.2）：价格类保留 2 位小数，盈亏与评分特殊格式化 */
  const overviewColumns: TableColumnsType<SellAdvice> = [
    {
      title: "当前价",
      dataIndex: "current_price",
      key: "current_price",
      render: (v: number) => fmt2(v),
    },
    {
      title: "盈亏比例",
      dataIndex: "profit_pct",
      key: "profit_pct",
      render: (v: number) => `${v.toFixed(2)}%`,
    },
    {
      title: "建议",
      dataIndex: "suggestion",
      key: "suggestion",
      render: (v: Suggestion) => <Tag color={suggestionTagColor(v)}>{v}</Tag>,
    },
    {
      title: "推荐止损",
      dataIndex: "stop_loss",
      key: "stop_loss",
      render: (v: number | null) => fmt2(v),
    },
    {
      title: "移动止盈",
      dataIndex: "trailing_stop",
      key: "trailing_stop",
      render: (v: number | null) => fmt2(v),
    },
    {
      title: "持有期最高价",
      dataIndex: "highest_price",
      key: "highest_price",
      render: (v: number | null) => fmt2(v),
    },
    {
      title: "健康评分",
      dataIndex: "health_score",
      key: "health_score",
      render: (v: number) => Math.round(v),
    },
  ];

  /** 分批止盈目标表列（需求 12.3） */
  const takeProfitColumns: TableColumnsType<TakeProfitTarget> = [
    {
      title: "目标价",
      dataIndex: "price",
      key: "price",
      render: (v: number) => v.toFixed(2),
    },
    {
      title: "卖出比例",
      dataIndex: "ratio",
      key: "ratio",
      render: (v: number) => `${(v * 100).toFixed(2)}%`,
    },
    {
      title: "说明",
      dataIndex: "reason",
      key: "reason",
    },
    {
      title: "是否达到",
      dataIndex: "reached",
      key: "reached",
      render: (v: boolean) => (v ? "是" : "否"),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>我的股票合适卖</Title>

      {/* 持仓输入表单（需求 1.1）：code / cost / position 必填，buy_date 可选 */}
      <Form layout="inline" style={{ marginBottom: 24, rowGap: 16, flexWrap: "wrap" }}>
        <Form.Item
          label="股票代码"
          required
          validateStatus={fieldErrors.code ? "error" : undefined}
          help={fieldErrors.code}
        >
          <Input
            placeholder="6 位沪深主板代码"
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value)}
            style={{ width: 180 }}
          />
        </Form.Item>

        <Form.Item
          label="成本价"
          required
          validateStatus={fieldErrors.cost ? "error" : undefined}
          help={fieldErrors.cost}
        >
          <Input
            placeholder="0.01–999999.99"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            style={{ width: 160 }}
          />
        </Form.Item>

        <Form.Item
          label="持仓数量"
          required
          validateStatus={fieldErrors.position ? "error" : undefined}
          help={fieldErrors.position}
        >
          <Input
            placeholder="1–9999999999"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            style={{ width: 160 }}
          />
        </Form.Item>

        <Form.Item
          label="买入日期"
          validateStatus={fieldErrors.buyDate ? "error" : undefined}
          help={fieldErrors.buyDate}
        >
          <DatePicker
            format="YYYYMMDD"
            placeholder="可选"
            // 禁止选择未来日期（合法性最终以 validateInputs 为准）
            disabledDate={(current) => !!current && current.valueOf() > Date.now()}
            onChange={(_, dateString) =>
              setBuyDate(typeof dateString === "string" ? dateString : "")
            }
          />
        </Form.Item>

        <Form.Item>
          {/* 请求处理中禁用按钮并显示加载态（需求 12.5） */}
          <Button type="primary" onClick={handleSubmit} loading={loading} disabled={loading}>
            {loading ? "计算中…" : "计算卖出建议"}
          </Button>
        </Form.Item>
      </Form>

      {/* 错误提示（含超时）：不渲染结果表格、保留输入（需求 12.6、12.7） */}
      {error && (
        <Alert
          type="error"
          showIcon
          message="请求失败"
          description={error}
          style={{ marginBottom: 24 }}
        />
      )}

      {/* 加载指示器（需求 12.5） */}
      <Spin spinning={loading}>
        {advice && !error && (
          <>
            {/* 概览表（需求 12.1、12.2）：单行展示核心指标 */}
            <Table<SellAdvice>
              title={() => "策略概览"}
              columns={overviewColumns}
              dataSource={[advice]}
              rowKey={() => "overview"}
              pagination={false}
              style={{ marginBottom: 24 }}
            />

            {/* 分批止盈目标表（需求 12.3、12.4）：为空时 antd 自动显示空数据占位，不渲染档位行 */}
            <Table<TakeProfitTarget>
              title={() => "分批止盈目标"}
              columns={takeProfitColumns}
              dataSource={advice.take_profit}
              rowKey={(row) => row.reason}
              pagination={false}
            />
          </>
        )}
      </Spin>
    </div>
  );
}
