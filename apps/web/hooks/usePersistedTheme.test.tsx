import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { THEMES, usePersistedTheme } from "./usePersistedTheme";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("THEMES", () => {
  it("exposes the supported set", () => {
    expect(THEMES).toEqual(["light", "sepia", "dark"]);
  });
});

describe("usePersistedTheme", () => {
  it("defaults to 'light' and does not stamp data-theme on the first run", () => {
    const { result } = renderHook(() => usePersistedTheme());
    expect(result.current[0]).toBe("light");
    // First-run guard prevents clobbering the pre-paint attribute set
    // by public/theme-init.js — so the hook stays quiet on mount.
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("hydrates from localStorage on mount", () => {
    window.localStorage.setItem("openflipbook.theme", "dark");
    const { result } = renderHook(() => usePersistedTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("ignores invalid stored values", () => {
    window.localStorage.setItem("openflipbook.theme", "neon");
    const { result } = renderHook(() => usePersistedTheme());
    expect(result.current[0]).toBe("light");
  });

  it("setting a new theme writes localStorage AND reflects on <html data-theme>", () => {
    const { result } = renderHook(() => usePersistedTheme());
    act(() => result.current[1]("sepia"));
    expect(window.localStorage.getItem("openflipbook.theme")).toBe("sepia");
    expect(document.documentElement.getAttribute("data-theme")).toBe("sepia");
  });
});
