"use client";

import { useCallback, useRef } from "react";

export interface PrefetchEntry {
  subject: string;
  style: string;
  subject_context?: string;
}

export const PREFETCH_PER_PAGE = 6;
export const PREFETCH_LRU_MAX = 200;

/**
 * Owns the in-memory hover/click prefetch cache plus the discipline knobs
 * around it (serial in-flight, per-page bucket cap, debounce timer).
 *
 * Why a single hook: the cache, the in-flight map, the debounce timer, the
 * "current key" pointer, and the per-page count map are all touched together
 * by the precompute effect, the hover effect, and the click handler. Keeping
 * them as one unit lets the eventual usePrefetchCache full-extraction PR
 * absorb those handlers without re-plumbing each ref individually.
 */
export function usePrefetchCache() {
  const cacheRef = useRef<Map<string, PrefetchEntry>>(new Map());
  const inflightRef = useRef<Map<string, AbortController>>(new Map());
  const timerRef = useRef<number | null>(null);
  const currentKeyRef = useRef<string | null>(null);
  const perPageCountRef = useRef<Map<string, number>>(new Map());

  // 3% grid — tighter than the original 5% so the 8 precomputed candidates
  // map to distinct buckets, but still loose enough that nearby hovers reuse
  // the same VLM round-trip. Sweet spot: ~33 buckets per axis = 1089 cells
  // total, well below PREFETCH_LRU_MAX.
  const bucketKey = useCallback(
    (nodeId: string | null, xPct: number, yPct: number): string => {
      const xb = Math.round(xPct * 33);
      const yb = Math.round(yPct * 33);
      return `${nodeId ?? "noid"}:${xb}:${yb}`;
    },
    [],
  );

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback((): void => {
    clearTimer();
    currentKeyRef.current = null;
    for (const ac of inflightRef.current.values()) ac.abort();
    inflightRef.current.clear();
  }, [clearTimer]);

  return {
    cacheRef,
    inflightRef,
    timerRef,
    currentKeyRef,
    perPageCountRef,
    bucketKey,
    clearTimer,
    reset,
  } as const;
}
