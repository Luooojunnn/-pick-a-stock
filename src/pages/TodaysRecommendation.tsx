import { useState } from "react";
import { Button } from "@/components/ui/button";

/** 候选股票（与后端 /api/daily-recommendations 返回结构一致） */
interface CandidateStock {
  ts_code: string;
  name: string;
  volumeGrade: "理想条件" | "放宽条件";
  maGrade: "理想条件" | "放宽条件";
}

type RecommendationResponse =
  | { code: 0; data: CandidateStock[]; logs?: string[] }
  | { code: -1; message: string; logs?: string[] };

export function TodaysRecommendation() {
  const [candidates, setCandidates] = useState<CandidateStock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  async function fetchRecommendations() {
    setLoading(true);
    setError(null);
    setLogs([]);
    try {
      const res = await fetch("/api/daily-recommendations");
      const json: RecommendationResponse = await res.json();
      const stageLogs = json.logs ?? [];
      setLogs(stageLogs);

      // 无论成功/失败，都把完整响应与阶段日志打印到浏览器控制台
      console.log("[screening] 完整响应：", json);
      console.log("[screening] 阶段日志：\n" + stageLogs.join("\n"));

      if (json.code === 0) {
        setCandidates(json.data);
        console.log(`[screening] 成功：命中 ${json.data.length} 只候选`, json.data);
      } else {
        setError(json.message || "获取推荐失败");
        setCandidates([]);
        console.error("[screening] 失败：", json.message);
      }
      setLoaded(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setCandidates([]);
      setLoaded(true);
      console.error("[screening] 请求失败：", err);
    } finally {
      setLoading(false);
    }
  }

  /** 分级标签的样式：理想条件用绿色，放宽条件用琥珀色 */
  function gradeClass(grade: CandidateStock["volumeGrade"]) {
    return grade === "理想条件"
      ? "inline-block rounded px-2 py-0.5 text-xs bg-green-100 text-green-700"
      : "inline-block rounded px-2 py-0.5 text-xs bg-amber-100 text-amber-700";
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold mb-4">今日推荐</h1>
      <Button onClick={fetchRecommendations} disabled={loading}>
        {loading ? "筛选中…" : "获取今日推荐"}
      </Button>

      {error && (
        <p className="mt-4 text-sm text-red-600">出错了：{error}</p>
      )}

      {logs.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium mb-1">执行日志</p>
          <pre className="max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100 whitespace-pre-wrap">
            {logs.join("\n")}
          </pre>
        </div>
      )}

      {loaded && !error && candidates.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          今日暂无符合条件的股票。
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="mt-4 space-y-2">
          {candidates.map((stock) => (
            <li
              key={stock.ts_code}
              className="flex items-center justify-between rounded-md border px-4 py-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{stock.name}</span>
                <span className="text-sm text-muted-foreground">
                  {stock.ts_code}
                </span>
              </div>
              <div className="flex gap-2">
                <span className={gradeClass(stock.volumeGrade)}>
                  量能 {stock.volumeGrade}
                </span>
                <span className={gradeClass(stock.maGrade)}>
                  均线 {stock.maGrade}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
