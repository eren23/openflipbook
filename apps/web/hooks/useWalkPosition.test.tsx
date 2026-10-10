import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWalkPosition } from "./useWalkPosition";

afterEach(() => vi.unstubAllGlobals());

const ok = () => new Response(JSON.stringify({ revision: 0, pose: null }), { status: 200 });

describe("useWalkPosition", () => {
  it("retries the first load after a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWalkPosition("s1"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("idle");
  });

  it("reports an error after three failed loads", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useWalkPosition("s1"));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.current).toMatchObject({ ready: false, state: { status: "error", message: "Failed to fetch" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
