import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrefetchEntry } from "./usePrefetchCache";
import {
  isHoverResolved,
  PRECOMPUTE_PER_PAGE,
  PREFETCH_LRU_MAX,
  PREFETCH_PER_PAGE,
  usePrefetchCache,
} from "./usePrefetchCache";

describe("usePrefetchCache constants", () => {
  it("exports the per-page bucket cap and LRU ceiling", () => {
    expect(PREFETCH_PER_PAGE).toBeGreaterThan(0);
    expect(PREFETCH_LRU_MAX).toBeGreaterThanOrEqual(PREFETCH_PER_PAGE);
  });
});

describe("bucketKey", () => {
  it("rounds to a 33-cell-per-axis grid (3% buckets)", () => {
    const { result } = renderHook(() => usePrefetchCache());
    // Bucket 17 spans roughly [16.5/33, 17.5/33) ≈ [0.500, 0.530); pick two
    // points well inside that range so jitter doesn't push us across.
    const k1 = result.current.bucketKey("nodeA", 0.515, 0.515);
    const k2 = result.current.bucketKey("nodeA", 0.520, 0.520);
    expect(k1).toBe(k2);
    // Big spatial gap → distinct bucket.
    const k3 = result.current.bucketKey("nodeA", 0.0, 0.0);
    expect(k3).not.toBe(k1);
    // Naming format: `${nodeId}:${xb}:${yb}`.
    expect(k1).toMatch(/^nodeA:\d+:\d+$/);
  });

  it("differs by node id", () => {
    const { result } = renderHook(() => usePrefetchCache());
    const a = result.current.bucketKey("a", 0.5, 0.5);
    const b = result.current.bucketKey("b", 0.5, 0.5);
    expect(a).not.toBe(b);
  });

  it("falls back to 'noid' when nodeId is null", () => {
    const { result } = renderHook(() => usePrefetchCache());
    expect(result.current.bucketKey(null, 0.5, 0.5)).toMatch(/^noid:/);
  });
});

describe("clearTimer / reset", () => {
  it("clearTimer cancels a pending setTimeout and clears the ref", () => {
    const { result } = renderHook(() => usePrefetchCache());
    const clearSpy = vi.spyOn(window, "clearTimeout");
    result.current.timerRef.current = window.setTimeout(() => {}, 1000);
    act(() => result.current.clearTimer());
    expect(clearSpy).toHaveBeenCalled();
    expect(result.current.timerRef.current).toBeNull();
    clearSpy.mockRestore();
  });

  it("reset aborts every in-flight controller and empties the inflight map", () => {
    const { result } = renderHook(() => usePrefetchCache());
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const abortSpy1 = vi.spyOn(ac1, "abort");
    const abortSpy2 = vi.spyOn(ac2, "abort");
    result.current.inflightRef.current.set("k1", ac1);
    result.current.inflightRef.current.set("k2", ac2);
    act(() => result.current.reset());
    expect(abortSpy1).toHaveBeenCalledTimes(1);
    expect(abortSpy2).toHaveBeenCalledTimes(1);
    expect(result.current.inflightRef.current.size).toBe(0);
  });
});

describe("PrefetchEntry shape", () => {
  it("accepts the legacy minimal shape (backward compat)", () => {
    const legacy: PrefetchEntry = { subject: "boiler", style: "" };
    expect(legacy.groundable).toBeUndefined();
    expect(legacy.confidence).toBeUndefined();
    expect(legacy.point).toBeUndefined();
    expect(legacy.bbox).toBeUndefined();
  });

  it("accepts the full groundability payload", () => {
    const full: PrefetchEntry = {
      subject: "boiler",
      style: "flat infographic",
      subject_context: "the steam generator",
      groundable: true,
      confidence: 0.92,
      point: { x: 0.42, y: 0.61 },
      bbox: { x: 0.3, y: 0.5, w: 0.25, h: 0.3 },
    };
    expect(full.groundable).toBe(true);
    expect(full.confidence).toBe(0.92);
    expect(full.point?.x).toBe(0.42);
    expect(full.bbox?.w).toBe(0.25);
  });

  it("treats groundable=false as a low-confidence flag", () => {
    const blocked: PrefetchEntry = {
      subject: "background sky",
      style: "",
      groundable: false,
      confidence: 0.1,
    };
    expect(blocked.groundable).toBe(false);
    // Consumers should suppress page-gen on this entry.
    expect(blocked.groundable === false && (blocked.confidence ?? 1) < 0.5).toBe(true);
  });

  it("exposes an independent candidate budget map", () => {
    const { result } = renderHook(() => usePrefetchCache());
    expect(result.current.candidateCountRef.current).not.toBe(
      result.current.perPageCountRef.current
    );
    result.current.candidateCountRef.current.set("n1", 8);
    expect(result.current.perPageCountRef.current.get("n1")).toBeUndefined();
  });

  it("PRECOMPUTE_PER_PAGE covers the whole 8-candidate precompute", () => {
    expect(PRECOMPUTE_PER_PAGE).toBe(8);
    expect(PRECOMPUTE_PER_PAGE).toBeGreaterThanOrEqual(PREFETCH_PER_PAGE);
  });

  it("isHoverResolved: candidate-only entries are upgrade-eligible", () => {
    expect(isHoverResolved(undefined)).toBe(false);
    // precompute writes: subject/style(/enter_as) only — upgradeable
    expect(isHoverResolved({ subject: "castle", style: "" })).toBe(false);
    expect(
      isHoverResolved({ subject: "castle", style: "", enter_as: "scene" })
    ).toBe(false);
    // a full hover resolve is complete
    expect(
      isHoverResolved({ subject: "castle", style: "", groundable: true })
    ).toBe(true);
    // a RESOLVED blank is complete too (a known nothing, not re-fetchable)
    expect(
      isHoverResolved({ subject: "sky", style: "", groundable: false })
    ).toBe(true);
  });
});
