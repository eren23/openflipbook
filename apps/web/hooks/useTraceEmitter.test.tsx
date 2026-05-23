import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trace", () => ({
  emit: vi.fn(),
  setLastTrace: vi.fn(),
  nowMs: vi.fn(() => 12345),
}));

import { emit, nowMs, setLastTrace } from "@/lib/trace";

import { useTraceEmitter } from "./useTraceEmitter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTraceEmitter", () => {
  it("bindTrace(id) sets the last-trace and does NOT emit sse:status by default", () => {
    const { result } = renderHook(() => useTraceEmitter());
    result.current.bindTrace("abc");
    expect(setLastTrace).toHaveBeenCalledTimes(1);
    expect(setLastTrace).toHaveBeenCalledWith("abc");
    expect(emit).not.toHaveBeenCalled();
  });

  it("bindTrace(id, { announce: true }) ALSO emits sse:status with stage=request + nowMs", () => {
    const { result } = renderHook(() => useTraceEmitter());
    result.current.bindTrace("abc", { announce: true });
    expect(setLastTrace).toHaveBeenCalledTimes(1);
    expect(setLastTrace).toHaveBeenCalledWith("abc");
    expect(nowMs).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("sse:status", {
      stage: "request",
      trace_id: "abc",
      t: 12345,
    });
  });

  it("bindTrace reference is stable across re-renders (useCallback)", () => {
    const { result, rerender } = renderHook(() => useTraceEmitter());
    const first = result.current.bindTrace;
    rerender();
    rerender();
    expect(result.current.bindTrace).toBe(first);
  });
});
