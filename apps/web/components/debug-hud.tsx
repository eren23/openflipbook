"use client";

import { useEffect, useRef, useState } from "react";
import {
  type HudEventName,
  on,
  getLastTrace,
} from "@/lib/trace";

interface SseEntry {
  stage: string;
  page_title?: string;
  subject?: string;
  t: number;
}

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get("debug") === "1") return true;
  try {
    return window.localStorage.getItem("flipbookDebug") === "1";
  } catch {
    return false;
  }
}

function copy(s: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(s);
}

/** Dev-only perf overlay for /play. Subscribes to the in-process pubsub
 *  in `lib/trace.ts`; never enabled in production unless explicitly
 *  toggled via `?debug=1` or `localStorage.flipbookDebug=1`. */
interface WorldEntry {
  added: number;
  updated: number;
  added_names: string[];
  updated_names: string[];
  dur_ms: number;
  t: number;
}

export default function DebugHud() {
  const [enabled, setEnabled] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [sse, setSse] = useState<SseEntry[]>([]);
  const [lastDecodeMs, setLastDecodeMs] = useState<number | null>(null);
  const [lastMorphMs, setLastMorphMs] = useState<number | null>(null);
  const [prefetchHits, setPrefetchHits] = useState(0);
  const [prefetchMisses, setPrefetchMisses] = useState(0);
  const [prefetchInflight, setPrefetchInflight] = useState(0);
  const [worldEntities, setWorldEntities] = useState<{
    total: number;
    recent: WorldEntry[];
    last_error: { status: number; t: number } | null;
  }>({ total: 0, recent: [], last_error: null });
  const commitCountRef = useRef(0);
  const [, setTick] = useState(0);

  // Cheap commit counter: increments every render of any subscribed effect
  // below. Read off ref in the displayed value to avoid an infinite loop.
  commitCountRef.current += 1;

  useEffect(() => {
    setEnabled(isEnabled());
    setTrace(getLastTrace());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const offs: Array<() => void> = [];
    const sub = (name: HudEventName, cb: (p: unknown) => void) => {
      offs.push(on(name, cb));
    };
    sub("trace:set", (p: unknown) => {
      const id = (p as { id?: string })?.id;
      if (typeof id === "string") setTrace(id);
    });
    sub("sse:status", (p: unknown) => {
      const v = p as SseEntry;
      setSse((prev) => {
        const entry: SseEntry = { stage: v.stage, t: v.t };
        if (v.page_title) entry.page_title = v.page_title;
        if (v.subject) entry.subject = v.subject;
        return [...prev.slice(-9), entry];
      });
    });
    sub("sse:final", (p: unknown) => {
      const v = p as { t?: number };
      setSse((prev) => [
        ...prev.slice(-9),
        { stage: "final", t: v?.t ?? 0 },
      ]);
    });
    sub("sse:error", () => {
      setSse((prev) => [...prev.slice(-9), { stage: "error", t: 0 }]);
    });
    sub("image:decode", (p: unknown) => {
      const ms = (p as { ms?: number })?.ms;
      if (typeof ms === "number") setLastDecodeMs(Math.round(ms));
    });
    sub("morph:end", (p: unknown) => {
      const ms = (p as { duration_ms?: number })?.duration_ms;
      if (typeof ms === "number") setLastMorphMs(Math.round(ms));
    });
    sub("prefetch:hit", () => setPrefetchHits((n) => n + 1));
    sub("prefetch:miss", () => setPrefetchMisses((n) => n + 1));
    sub("prefetch:inflight", (p: unknown) => {
      const n = (p as { n?: number })?.n;
      if (typeof n === "number") setPrefetchInflight(n);
    });
    sub("world:extracted", (p: unknown) => {
      const v = p as {
        added?: number;
        updated?: number;
        added_entities?: { name: string }[];
        updated_entities?: { name: string }[];
        dur_ms?: number;
        t?: number;
      };
      const entry: WorldEntry = {
        added: v.added ?? 0,
        updated: v.updated ?? 0,
        added_names: (v.added_entities ?? []).map((e) => e.name),
        updated_names: (v.updated_entities ?? []).map((e) => e.name),
        dur_ms: v.dur_ms ?? 0,
        t: v.t ?? 0,
      };
      setWorldEntities((prev) => ({
        total: prev.total + entry.added,
        recent: [...prev.recent.slice(-3), entry],
        last_error: prev.last_error,
      }));
    });
    sub("world:extract_error", (p: unknown) => {
      const v = p as { status?: number; t?: number };
      setWorldEntities((prev) => ({
        ...prev,
        last_error: { status: v.status ?? 0, t: v.t ?? 0 },
      }));
    });
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    offs.push(() => clearInterval(id));
    return () => {
      for (const off of offs) off();
    };
  }, [enabled]);

  if (!enabled) return null;

  const total = prefetchHits + prefetchMisses;
  const hitRate = total === 0 ? "—" : `${Math.round((prefetchHits / total) * 100)}%`;
  const t0 = sse[0]?.t ?? 0;

  return (
    <div className="pointer-events-auto fixed bottom-3 right-3 z-[70] w-72 rounded-md border border-black/40 bg-black/85 p-3 font-mono text-[11px] leading-tight text-green-300 shadow-xl">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-bold text-green-200">debug HUD</span>
        <button
          type="button"
          className="rounded bg-green-300/20 px-1 text-[10px] text-green-100 hover:bg-green-300/30"
          onClick={() => {
            try {
              window.localStorage.setItem("flipbookDebug", "0");
            } catch {
              /* no-op */
            }
            setEnabled(false);
          }}
        >
          off
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className="opacity-70">trace</span>
        <code className="truncate">{trace ?? "—"}</code>
        {trace && (
          <button
            type="button"
            className="rounded bg-green-300/20 px-1 text-[10px] text-green-100 hover:bg-green-300/30"
            onClick={() => copy(trace)}
            title="Copy trace ID"
          >
            ⎘
          </button>
        )}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-2">
        <div>decode {lastDecodeMs ?? "—"}ms</div>
        <div>morph {lastMorphMs ?? "—"}ms</div>
        <div>
          prefetch {hitRate} ({prefetchHits}/{total})
        </div>
        <div>inflight {prefetchInflight}</div>
        <div className="col-span-2">commits {commitCountRef.current}</div>
      </div>
      {sse.length > 0 && (
        <div className="mt-1 border-t border-green-200/20 pt-1">
          <div className="mb-0.5 opacity-70">sse timeline</div>
          {sse.map((e, i) => (
            <div key={i} className="truncate">
              <span className="opacity-60">+{Math.round(e.t - t0)}ms</span>{" "}
              <span className="text-green-200">{e.stage}</span>{" "}
              {e.subject && <span className="opacity-80">{e.subject}</span>}
              {e.page_title && (
                <span className="opacity-80">{e.page_title}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {(worldEntities.recent.length > 0 || worldEntities.last_error) && (
        <div className="mt-1 border-t border-green-200/20 pt-1">
          <div className="mb-0.5 opacity-70">
            world{" "}
            <span className="opacity-60">
              ({worldEntities.total} added total)
            </span>
          </div>
          {worldEntities.recent.map((entry, i) => (
            <div key={i} className="truncate">
              <span className="opacity-60">+{entry.dur_ms}ms</span>{" "}
              <span className="text-green-200">+{entry.added}</span>/
              <span className="text-green-200">~{entry.updated}</span>{" "}
              <span className="opacity-80">
                {[...entry.added_names, ...entry.updated_names]
                  .slice(0, 4)
                  .join(", ") || "—"}
              </span>
            </div>
          ))}
          {worldEntities.last_error && (
            <div className="truncate text-red-300">
              extract err: HTTP {worldEntities.last_error.status}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
