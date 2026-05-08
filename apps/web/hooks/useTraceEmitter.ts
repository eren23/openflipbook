"use client";

import { useCallback } from "react";

import { emit as hudEmit, nowMs, setLastTrace } from "@/lib/trace";

/**
 * Centralizes the "I just minted / received a new trace id" ritual: push it
 * onto the global last-trace channel that the debug HUD reads, optionally
 * fire an `sse:status` request marker for the timeline view.
 *
 * Other call sites keep using `emit()` directly — the hook isn't a wrapper
 * around the whole telemetry surface, just a dedupe of the boilerplate that
 * previously lived inline in three different places.
 */
export function useTraceEmitter() {
  const bindTrace = useCallback((traceId: string, opts?: { announce?: boolean }): void => {
    setLastTrace(traceId);
    if (opts?.announce) {
      hudEmit("sse:status", { stage: "request", trace_id: traceId, t: nowMs() });
    }
  }, []);

  return { bindTrace } as const;
}
