// Wander safety: the page cap (a forgotten ▶ can't wander off with the
// wallet), the stop reasons, and the re-arm reset. Real timers + tiny lingers
// keep these deterministic without fake-timer/microtask juggling.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWander, WANDER_MAX_PAGES, type WanderStopReason } from "./useWander";

const CANDIDATES = {
  candidates: [
    { x_pct: 0.5, y_pct: 0.4, salience: 0.9 },
    { x_pct: 0.2, y_pct: 0.7, salience: 0.5 },
  ],
};

function stubFetch(payload: unknown = CANDIDATES, ok = true) {
  const fn = vi.fn(async () => ({ ok, json: async () => payload }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

interface HookProps {
  active: boolean;
  nodeId: string;
}

function mount(
  tap: (x: number, y: number) => void,
  exhausted: (reason: WanderStopReason) => void,
  maxPages: number,
  initial: HookProps = { active: true, nodeId: "a" },
) {
  return renderHook(
    ({ active, nodeId }: HookProps) =>
      useWander({
        active,
        phase: "ready",
        nodeId,
        imageDataUrl: "data:image/jpeg;base64,xxx",
        title: "t",
        query: "q",
        outputLocale: null,
        dispatchTapAt: tap,
        onExhausted: exhausted,
        lingerMs: 5,
        maxPages,
      }),
    { initialProps: initial },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useWander safety", () => {
  it("auto-taps a top candidate after the linger", async () => {
    stubFetch();
    const tap = vi.fn();
    mount(tap, vi.fn(), 8);
    await tick();
    expect(tap).toHaveBeenCalledTimes(1);
    const [x, y] = tap.mock.calls[0]!;
    // random among top-3 — both stubbed candidates are acceptable picks
    expect([0.5, 0.2]).toContain(x);
    expect([0.4, 0.7]).toContain(y);
  });

  it("stops with max-pages after maxPages taps and fires no further tap", async () => {
    stubFetch();
    const tap = vi.fn();
    const exhausted = vi.fn();
    const { rerender } = mount(tap, exhausted, 2);
    await tick();
    rerender({ active: true, nodeId: "b" });
    await tick();
    expect(tap).toHaveBeenCalledTimes(2);
    rerender({ active: true, nodeId: "c" });
    await tick();
    expect(tap).toHaveBeenCalledTimes(2); // the cap held
    expect(exhausted).toHaveBeenCalledWith("max-pages");
  });

  it("reports no-candidates and resolver-error", async () => {
    stubFetch({ candidates: [] });
    const exhausted = vi.fn();
    mount(vi.fn(), exhausted, 8);
    await tick();
    expect(exhausted).toHaveBeenCalledWith("no-candidates");

    stubFetch({}, false);
    const exhausted2 = vi.fn();
    mount(vi.fn(), exhausted2, 8);
    await tick();
    expect(exhausted2).toHaveBeenCalledWith("resolver-error");
  });

  it("re-arming wander resets the page counter", async () => {
    stubFetch();
    const tap = vi.fn();
    const exhausted = vi.fn();
    const { rerender } = mount(tap, exhausted, 1);
    await tick();
    expect(tap).toHaveBeenCalledTimes(1);
    rerender({ active: true, nodeId: "b" });
    await tick();
    expect(exhausted).toHaveBeenCalledWith("max-pages"); // capped at 1
    // toggle off (resets the counter), then a fresh run on a new node
    rerender({ active: false, nodeId: "b" });
    rerender({ active: true, nodeId: "c" });
    await tick();
    expect(tap).toHaveBeenCalledTimes(2);
  });

  it("the default cap is the documented seatbelt", () => {
    expect(WANDER_MAX_PAGES).toBe(8);
  });
});
