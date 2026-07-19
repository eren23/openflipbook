// Per-session World Mode preference: the build-time NEXT_PUBLIC seed, the
// per-session localStorage persistence, and the hydrate-on-session-change
// coercion of stored garbage. MemoryStorage comes from tests/setup.ts.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorldMode } from "./useWorldMode";

const key = (sid: string) => `openflipbook.worldMode.${sid}`;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("useWorldMode", () => {
  it("defaults off / auto / no DOM labels when nothing is stored or seeded", () => {
    const { result } = renderHook(() => useWorldMode("s1"));
    expect(result.current.enabled).toBe(false);
    expect(result.current.autonomy).toBe("auto");
    expect(result.current.domLabels).toBe(false);
  });

  it("persists toggles per session and re-hydrates them on remount", () => {
    const { result, unmount } = renderHook(() => useWorldMode("s1"));
    act(() => result.current.setEnabled(true));
    act(() => result.current.setAutonomy("semi"));
    act(() => result.current.setDomLabels(true));
    expect(JSON.parse(window.localStorage.getItem(key("s1"))!)).toEqual({
      enabled: true,
      autonomy: "semi",
      domLabels: true,
    });
    unmount();

    const { result: again } = renderHook(() => useWorldMode("s1"));
    expect(again.current.enabled).toBe(true);
    expect(again.current.autonomy).toBe("semi");
    expect(again.current.domLabels).toBe(true);
  });

  it("keeps sessions independent: switching sessionId hydrates THAT session's pref", () => {
    const { result, rerender } = renderHook(({ sid }) => useWorldMode(sid), {
      initialProps: { sid: "s1" },
    });
    act(() => result.current.setEnabled(true));

    rerender({ sid: "s2" });
    expect(result.current.enabled).toBe(false); // fresh session, fresh default

    rerender({ sid: "s1" });
    expect(result.current.enabled).toBe(true); // s1's own toggle survives
  });

  it("coerces stored garbage back to safe values", () => {
    window.localStorage.setItem(
      key("s1"),
      JSON.stringify({ enabled: "yes", autonomy: "yolo", domLabels: 1 }),
    );
    const { result } = renderHook(() => useWorldMode("s1"));
    expect(result.current.enabled).toBe(false);
    expect(result.current.autonomy).toBe("auto");
    expect(result.current.domLabels).toBe(false);
  });

  it("falls back to the default on unparseable storage", () => {
    window.localStorage.setItem(key("s1"), "{not json");
    const { result } = renderHook(() => useWorldMode("s1"));
    expect(result.current.enabled).toBe(false);
    expect(result.current.autonomy).toBe("auto");
  });

  it("NEXT_PUBLIC_WORLD_MODE / _DOM_LABELS seed new sessions ON", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORLD_MODE", "1");
    vi.stubEnv("NEXT_PUBLIC_DOM_LABELS", "true");
    vi.resetModules(); // the seeds are read at module import
    const fresh = await import("./useWorldMode");
    const { result } = renderHook(() => fresh.useWorldMode("seeded"));
    expect(result.current.enabled).toBe(true);
    expect(result.current.domLabels).toBe(true);
  });

  it("a session's stored OFF beats the env seed (the toggle wins)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORLD_MODE", "yes");
    vi.resetModules();
    const fresh = await import("./useWorldMode");
    window.localStorage.setItem(
      key("opted-out"),
      JSON.stringify({ enabled: false, autonomy: "auto", domLabels: false }),
    );
    const { result } = renderHook(() => fresh.useWorldMode("opted-out"));
    expect(result.current.enabled).toBe(false);
  });

  it("an unrecognized env value seeds OFF", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORLD_MODE", "on"); // not in the 1/true/yes set
    vi.resetModules();
    const fresh = await import("./useWorldMode");
    const { result } = renderHook(() => fresh.useWorldMode("s1"));
    expect(result.current.enabled).toBe(false);
  });
});
