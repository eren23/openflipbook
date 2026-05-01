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
export default function DebugHud() {
  const [enabled, setEnabled] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [sse, setSse] = useState<SseEntry[]>([]);
  const [lastDecodeMs, setLastDecodeMs] = useState<number | null>(null);
  const [lastMorphMs, setLastMorphMs] = useState<number | null>(null);
  const [prefetchHits, setPrefetchHits] = useState(0);
  const [prefetchMisses, setPrefetchMisses] = useState(0);
  const [prefetchInflight, setPrefetchInflight] = useState(0);
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
    </div>
  );
}
