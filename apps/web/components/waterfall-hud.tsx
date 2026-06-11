"use client";

import { useEffect, useState } from "react";
import { on, type HudEventName } from "@/lib/trace";
import {
  buildSegments,
  marksForEndReportedStage,
  type WaterfallMark as Mark,
  type WaterfallStage as StageKey,
} from "@/lib/waterfall-segments";

interface StageInfo {
  label: string;
  color: string;
}

const STAGE_INFO: Record<StageKey, StageInfo> = {
  request: { label: "warm-up", color: "rgba(120,120,120,0.7)" },
  click_resolving: { label: "vlm: read tap", color: "rgba(96,165,250,0.85)" },
  click_resolved: { label: "tap → subject", color: "rgba(59,130,246,0.85)" },
  planning: { label: "planner", color: "rgba(34,197,94,0.85)" },
  generating_image: { label: "image gen", color: "rgba(234,88,12,0.85)" },
  draft: { label: "draft preview", color: "rgba(245,158,11,0.85)" },
  verifying: { label: "vlm: verify", color: "rgba(20,184,166,0.85)" },
  final: { label: "final", color: "rgba(239,68,68,0.9)" },
  decode: { label: "decode", color: "rgba(168,85,247,0.85)" },
  idle: { label: "idle (tab hidden?)", color: "rgba(120,120,120,0.35)" },
  morph: { label: "reveal", color: "rgba(217,70,239,0.85)" },
};

interface RunState {
  traceId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  marks: Mark[];
  active: StageKey | null;
}

const EMPTY: RunState = {
  traceId: null,
  startedAt: null,
  endedAt: null,
  marks: [],
  active: null,
};

export default function WaterfallHUD() {
  const [run, setRun] = useState<RunState>(EMPTY);
  const [hasShown, setHasShown] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const offs: Array<() => void> = [];
    const sub = (name: HudEventName, cb: (p: unknown) => void) => {
      offs.push(on(name, cb));
    };

    sub("trace:set", (p: unknown) => {
      const id = (p as { id?: string; ts?: number })?.id ?? null;
      const ts = (p as { ts?: number })?.ts ?? 0;
      setRun({
        traceId: id,
        startedAt: ts || null,
        endedAt: null,
        marks: [],
        active: null,
      });
      setHasShown(true);
    });

    sub("sse:status", (p: unknown) => {
      const v = p as {
        stage?: string;
        t?: number;
        subject?: string;
        page_title?: string;
      };
      const stage = (v?.stage ?? "") as StageKey;
      if (!STAGE_INFO[stage]) return;
      setRun((prev) => ({
        ...prev,
        startedAt: prev.startedAt ?? v.t ?? 0,
        marks: [
          ...prev.marks,
          {
            stage,
            t: v.t ?? 0,
            ...(v.subject || v.page_title
              ? { hint: v.subject || v.page_title }
              : {}),
          },
        ],
        active: stage,
      }));
    });

    sub("sse:final", (p: unknown) => {
      const v = p as { t?: number; page_title?: string };
      setRun((prev) => ({
        ...prev,
        marks: [
          ...prev.marks,
          {
            stage: "final",
            t: v.t ?? 0,
            ...(v.page_title ? { hint: v.page_title } : {}),
          },
        ],
        active: "final",
      }));
    });

    sub("image:decode", (p: unknown) => {
      // End-reported: the event arrives when the browser decode RESOLVES,
      // carrying its measured ms + its start time. A backgrounded tab defers
      // the decode by minutes — that gap renders as `idle`, never as a
      // 100s+ "decode" bar (the 184813ms incident).
      const v = p as { ms?: number; t0?: number };
      const ms = typeof v?.ms === "number" ? v.ms : 0;
      setRun((prev) => {
        const lastT = prev.marks[prev.marks.length - 1]?.t ?? 0;
        const start = typeof v?.t0 === "number" ? v.t0 : lastT;
        return {
          ...prev,
          marks: marksForEndReportedStage(prev.marks, "decode", start, ms),
          active: null,
        };
      });
    });

    sub("morph:end", (p: unknown) => {
      // The reveal runs from the decode's end to this event's arrival; the
      // legacy duration_ms (measured since CLICK) is ignored for the bar.
      const v = p as { t?: number; duration_ms?: number };
      setRun((prev) => {
        const last = prev.marks[prev.marks.length - 1];
        const lastEnd = last == null ? 0 : (last.end ?? last.t);
        const endT = typeof v?.t === "number" ? v.t : lastEnd;
        return {
          ...prev,
          marks: [
            ...prev.marks,
            { stage: "morph", t: lastEnd, end: Math.max(endT, lastEnd) },
          ],
          endedAt: Math.max(endT, lastEnd),
          active: null,
        };
      });
    });

    sub("sse:error", () => {
      setRun((prev) => ({ ...prev, active: null, endedAt: Date.now() }));
    });

    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Tick at ~10fps while a run is active so the in-flight bar grows live.
  // Schedule the first tick via setTimeout (not a synchronous loop() call) so
  // the cleanup `clearTimeout(handle)` always cancels the right id even if
  // the effect re-runs before the first tick fires.
  useEffect(() => {
    if (run.active == null) return;
    let handle = 0;
    const loop = () => {
      setNow((n) => n + 1);
      handle = window.setTimeout(loop, 90) as unknown as number;
    };
    handle = window.setTimeout(loop, 90) as unknown as number;
    return () => window.clearTimeout(handle);
  }, [run.active]);

  if (!hasShown) return null;

  const { startedAt, marks, active, traceId } = run;
  const segments =
    startedAt != null
      ? buildSegments(marks, startedAt, active, performanceNow())
      : [];
  const totalMs =
    segments.length > 0 ? Math.max(1, segments[segments.length - 1]!.end) : 1;

  // Use `now` to keep the in-flight bar refreshing without a state mutation.
  void now;

  return (
    <div className="w-full rounded-xl border border-[var(--color-ink)]/15 bg-[var(--color-ink)]/5 px-3 py-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between gap-2 opacity-70">
        <span>
          <span className="font-medium">generation waterfall</span>
          <span className="ml-2 opacity-70">
            {active
              ? `· ${STAGE_INFO[active]?.label ?? active}…`
              : segments.length > 0
                ? `· ${Math.round(totalMs)}ms total`
                : "· waiting"}
          </span>
        </span>
        {traceId && (
          <span className="font-mono text-[10px] opacity-60" title={traceId}>
            trace: {traceId.slice(0, 8)}
          </span>
        )}
      </div>
      <div className="relative h-3 overflow-hidden rounded bg-[var(--color-ink)]/10">
        {segments.map((seg, i) => {
          const widthPct = ((seg.end - seg.start) / totalMs) * 100;
          const leftPct = (seg.start / totalMs) * 100;
          const info = STAGE_INFO[seg.stage];
          if (!info) return null;
          return (
            <div
              key={`${seg.stage}-${i}`}
              className="absolute top-0 h-full"
              style={{
                left: `${leftPct}%`,
                width: `${Math.max(widthPct, 0.4)}%`,
                background: info.color,
                transition: "width 90ms linear",
              }}
              title={`${info.label}: ${Math.round(seg.end - seg.start)}ms`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 opacity-70">
        {segments.map((seg, i) => {
          const info = STAGE_INFO[seg.stage];
          if (!info) return null;
          return (
            <span key={i} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: info.color }}
              />
              <span>
                {info.label} {Math.round(seg.end - seg.start)}ms
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function performanceNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
