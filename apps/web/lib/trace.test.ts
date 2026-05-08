import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRACE_HEADER,
  emit,
  getLastTrace,
  mark,
  measure,
  newTraceId,
  on,
  setLastTrace,
  withTrace,
} from "./trace";

describe("newTraceId", () => {
  it("returns a non-empty string each call", () => {
    expect(newTraceId()).toMatch(/.+/);
  });
  it("does not collide on rapid back-to-back calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 32; i++) ids.add(newTraceId());
    expect(ids.size).toBe(32);
  });
});

describe("withTrace", () => {
  it("attaches the trace header without dropping existing headers", () => {
    const init = withTrace({ headers: { "content-type": "application/json" } }, "abc");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get(TRACE_HEADER)).toBe("abc");
    expect(headers.get("content-type")).toBe("application/json");
  });
  it("works with undefined init", () => {
    const init = withTrace(undefined, "xyz");
    expect(new Headers(init.headers as HeadersInit).get(TRACE_HEADER)).toBe("xyz");
  });
});

describe("setLastTrace / getLastTrace", () => {
  it("round-trips the latest id", () => {
    setLastTrace("trace-1");
    expect(getLastTrace()).toBe("trace-1");
    setLastTrace("trace-2");
    expect(getLastTrace()).toBe("trace-2");
  });
});

describe("emit / on pubsub", () => {
  const subs: Array<() => void> = [];
  afterEach(() => {
    while (subs.length) subs.pop()?.();
  });

  it("delivers payloads to subscribers and supports unsubscribe", () => {
    const seen: unknown[] = [];
    subs.push(on("sse:status", (p) => seen.push(p)));
    emit("sse:status", { ok: 1 });
    emit("sse:status", { ok: 2 });
    expect(seen).toEqual([{ ok: 1 }, { ok: 2 }]);
    subs.pop()?.();
    emit("sse:status", { ok: 3 });
    expect(seen).toHaveLength(2);
  });

  it("a throwing listener does not break siblings", () => {
    const calls: string[] = [];
    subs.push(
      on("sse:error", () => {
        throw new Error("boom");
      }),
    );
    subs.push(on("sse:error", () => calls.push("sibling-ok")));
    emit("sse:error", null);
    expect(calls).toEqual(["sibling-ok"]);
  });
});

describe("mark / measure", () => {
  it("does not throw when performance is missing", () => {
    const original = globalThis.performance;
    // @ts-expect-error force the missing-API branch
    delete globalThis.performance;
    try {
      expect(() => mark("x")).not.toThrow();
      expect(measure("y", "x")).toBeNull();
    } finally {
      globalThis.performance = original;
    }
  });

  it("returns a duration when performance is present", () => {
    const m = vi.spyOn(performance, "measure").mockReturnValue({
      duration: 12.5,
    } as PerformanceMeasure);
    try {
      const d = measure("z", "start", "end");
      expect(d).toBe(12.5);
    } finally {
      m.mockRestore();
    }
  });
});
