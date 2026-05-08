import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useFirstRunCoach } from "./useFirstRunCoach";

const KEY = "openflipbook.coach.seen";

afterEach(() => {
  window.localStorage.clear();
});

describe("useFirstRunCoach", () => {
  it("first visit reports seen=false after the mount-effect runs", () => {
    const { result } = renderHook(() => useFirstRunCoach());
    // Default-true on first render (SSR-safe), flips to false once the
    // localStorage check runs.
    expect(result.current[0]).toBe(false);
  });

  it("dismiss persists `1` to localStorage and flips seen=true", () => {
    const { result } = renderHook(() => useFirstRunCoach());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
  });

  it("respects an already-set flag from a prior session", () => {
    window.localStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useFirstRunCoach());
    expect(result.current[0]).toBe(true);
  });

  it("dismiss is idempotent — calling twice doesn't break", () => {
    const { result } = renderHook(() => useFirstRunCoach());
    act(() => result.current[1]());
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
  });
});
