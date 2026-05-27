"use client";

import { useEffect, useMemo, useState } from "react";

import type { BackendTrace, TraceRecentResponse } from "@/lib/trace-types";
import { packSpansIntoRows, spanCategory, summarizeCategories } from "@/lib/trace-types";

const POLL_INTERVAL_MS = 5_000;
const ROW_HEIGHT = 22;
const ROW_GAP = 4;
const SPAN_VPAD = 4;
const SIDEBAR_WIDTH = 160;
const MIN_BAR_WIDTH = 2;

interface FetchState {
  loading: boolean;
  error: string | null;
  data: TraceRecentResponse | null;
  lastUpdate: number;
}

export default function TraceList({ initial }: { initial: TraceRecentResponse | null }) {
  const [state, setState] = useState<FetchState>({
    loading: false,
    error: null,
    data: initial,
    lastUpdate: Date.now(),
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [openTraceId, setOpenTraceId] = useState<string | null>(null);

  useEffect(() => {
    if (!autoRefresh) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/trace/recent?limit=50", { cache: "no-store" });
        const parsed = (await res.json()) as TraceRecentResponse;
        if (!cancelled) {
          setState({ loading: false, error: null, data: parsed, lastUpdate: Date.now() });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: (err as Error).message,
            lastUpdate: Date.now(),
          }));
        }
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [autoRefresh]);

  const traces = state.data?.traces ?? [];

  return (
    <div className="space-y-4">
      <Header
        state={state}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
        traceCount={traces.length}
      />

      {state.data?.error ? (
        <Banner kind="error">backend error: {state.data.error}</Banner>
      ) : null}

      {traces.length === 0 ? (
        <Banner kind="info">
          No traces in the ring buffer yet. Trigger a click or page generation to populate.
        </Banner>
      ) : null}

      <div className="space-y-3">
        {traces.map((trace) => (
          <TraceRow
            key={trace.trace_id}
            trace={trace}
            open={openTraceId === trace.trace_id}
            onToggle={() =>
              setOpenTraceId((current) => (current === trace.trace_id ? null : trace.trace_id))
            }
          />
        ))}
      </div>
    </div>
  );
}

function Header({
  state,
  autoRefresh,
  onToggleAutoRefresh,
  traceCount,
}: {
  state: FetchState;
  autoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  traceCount: number;
}) {
  return (
    <div className="flex items-center justify-between text-sm text-zinc-400">
      <div>
        {traceCount} trace{traceCount === 1 ? "" : "s"} • last refresh{" "}
        {formatClock(state.lastUpdate)}
      </div>
      <button
        type="button"
        onClick={onToggleAutoRefresh}
        className={`rounded-md border px-2 py-1 text-xs ${
          autoRefresh
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
        }`}
        aria-pressed={autoRefresh}
      >
        {autoRefresh ? "auto-refresh on" : "auto-refresh off"}
      </button>
    </div>
  );
}

function Banner({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "error" | "info";
}) {
  const color =
    kind === "error"
      ? "border-red-700 bg-red-900/30 text-red-200"
      : "border-zinc-700 bg-zinc-900/40 text-zinc-300";
  return <div className={`rounded-md border px-3 py-2 text-sm ${color}`}>{children}</div>;
}

function TraceRow({
  trace,
  open,
  onToggle,
}: {
  trace: BackendTrace;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = useMemo(() => summarizeCategories(trace.spans), [trace.spans]);
  const wallSec = (trace.wall_ms / 1000).toFixed(2);

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-900/40"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${trace.errored ? "bg-red-500" : "bg-emerald-500"}`} />
          <code className="text-zinc-300">{trace.trace_id}</code>
          <span className="text-zinc-500">{trace.span_count} spans</span>
        </div>
        <div className="flex items-center gap-3 text-zinc-400">
          <span>{wallSec}s</span>
          <span className="text-zinc-600">{formatClock(trace.start_ms)}</span>
        </div>
      </button>
      <div className="border-t border-zinc-900 px-3 py-2 text-xs text-zinc-500">
        {summary.map(({ label, color, totalMs }) => (
          <span key={label} className="mr-3 inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
            <span className="text-zinc-300">{label}</span>
            <span>{Math.round(totalMs)}ms</span>
          </span>
        ))}
      </div>
      {open ? <Flamegraph trace={trace} /> : null}
    </div>
  );
}

function Flamegraph({ trace }: { trace: BackendTrace }) {
  const packed = useMemo(() => packSpansIntoRows(trace.spans), [trace.spans]);
  const rowCount = packed.reduce((max, span) => Math.max(max, span.row + 1), 1);
  const height = rowCount * (ROW_HEIGHT + ROW_GAP) + SPAN_VPAD * 2;
  const span = Math.max(trace.wall_ms, 1);

  return (
    <div className="overflow-x-auto border-t border-zinc-900 bg-zinc-950 px-3 py-3">
      <div
        className="relative font-mono text-[11px]"
        style={{ minWidth: 640, height, paddingLeft: SIDEBAR_WIDTH }}
      >
        {packed.map((s, i) => {
          const { color } = spanCategory(s.name);
          const left =
            SIDEBAR_WIDTH +
            Math.max(0, ((s.start_ms - trace.start_ms) / span) * (100 * 8));
          const width = Math.max(
            MIN_BAR_WIDTH,
            ((s.end_ms - s.start_ms) / span) * (100 * 8)
          );
          const top = SPAN_VPAD + s.row * (ROW_HEIGHT + ROW_GAP);
          return (
            <div
              key={`${s.name}-${i}`}
              className="absolute rounded-sm border border-black/40 text-white"
              style={{
                left,
                top,
                width,
                height: ROW_HEIGHT,
                background: s.level === "error" ? "#dc2626" : color,
                opacity: s.level === "error" ? 1 : 0.85,
              }}
              title={`${s.name} • ${s.duration_ms.toFixed(1)}ms${
                s.error ? `\n${s.error}` : ""
              }${kvSummary(s.kv)}`}
            >
              <div className="overflow-hidden whitespace-nowrap px-1 leading-[22px]">
                {s.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function kvSummary(kv: Record<string, unknown> | undefined): string {
  if (!kv) return "";
  const entries = Object.entries(kv).slice(0, 6);
  if (entries.length === 0) return "";
  return (
    "\n" + entries.map(([k, v]) => `${k}=${truncate(String(v), 40)}`).join(" ")
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
