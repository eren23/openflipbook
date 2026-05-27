export interface BackendSpan {
  name: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  level: "info" | "error";
  error?: string;
  kv?: Record<string, unknown>;
}

export interface BackendTrace {
  trace_id: string;
  start_ms: number;
  end_ms: number;
  wall_ms: number;
  span_count: number;
  errored: boolean;
  spans: BackendSpan[];
}

export interface TraceRecentResponse {
  ok: boolean;
  service?: string;
  traces?: BackendTrace[];
  error?: string;
}

export interface AbortStageRow {
  stage: string;
  count: number;
  wasted_ms: number;
  wasted_usd: number;
  cost_per_sec: number;
}

export interface AbortEntry {
  ts_ms: number;
  stage: string;
  elapsed_ms: number;
  wasted_usd: number;
  cost_per_sec: number;
  trace_id?: string | null;
  mode?: string;
  [key: string]: unknown;
}

export interface AbortStatsResponse {
  ok: boolean;
  service?: string;
  total?: number;
  by_stage?: AbortStageRow[];
  recent?: AbortEntry[];
  error?: string;
}

const SPAN_COLORS: Array<{ match: RegExp; color: string; label: string }> = [
  { match: /^vlm\./, color: "#3b82f6", label: "vlm" },
  { match: /^plan(ner)?\./, color: "#22c55e", label: "planner" },
  { match: /^image[._]/, color: "#ea580c", label: "image-gen" },
  { match: /^video\./, color: "#a855f7", label: "video" },
  { match: /^world\./, color: "#14b8a6", label: "world-mem" },
  { match: /^(prefetch|precompute)\./, color: "#94a3b8", label: "prefetch" },
  { match: /^(save|r2|mongo|store)\./, color: "#ec4899", label: "persist" },
  { match: /^(http|fetch|net)\./, color: "#0ea5e9", label: "network" },
];

const FALLBACK_COLOR = "#64748b";

export function spanCategory(name: string): { color: string; label: string } {
  for (const rule of SPAN_COLORS) {
    if (rule.match.test(name)) return { color: rule.color, label: rule.label };
  }
  return { color: FALLBACK_COLOR, label: "other" };
}

export interface PackedSpan extends BackendSpan {
  row: number;
}

/**
 * Greedy row-packing: assign each span the lowest row whose previous span
 * ended before this span starts. Produces a Gantt where concurrent spans
 * occupy stacked rows.
 */
export function packSpansIntoRows(spans: BackendSpan[]): PackedSpan[] {
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms);
  const rows: number[] = [];
  const packed: PackedSpan[] = [];
  for (const span of sorted) {
    let row = rows.findIndex((endMs) => endMs <= span.start_ms);
    if (row === -1) {
      row = rows.length;
      rows.push(span.end_ms);
    } else {
      rows[row] = span.end_ms;
    }
    packed.push({ ...span, row });
  }
  return packed;
}

export interface CategorySummary {
  label: string;
  color: string;
  totalMs: number;
}

export function summarizeCategories(spans: BackendSpan[]): CategorySummary[] {
  const map = new Map<string, { color: string; totalMs: number }>();
  for (const s of spans) {
    const { color, label } = spanCategory(s.name);
    const cur = map.get(label) ?? { color, totalMs: 0 };
    cur.totalMs += s.duration_ms;
    map.set(label, cur);
  }
  return [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.totalMs - a.totalMs);
}
