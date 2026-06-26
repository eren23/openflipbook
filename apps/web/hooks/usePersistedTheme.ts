"use client";

import { usePersistedState } from "./usePersistedState";

export type Theme = "light" | "sepia" | "dark";
export const THEMES: readonly Theme[] = ["light", "sepia", "dark"] as const;

const KEY = "openflipbook.theme";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "sepia" || v === "dark";
}

/**
 * Theme preference persisted to localStorage and reflected onto the
 * `<html data-theme>` attribute. The first run is skipped (inside
 * usePersistedState) to avoid overwriting the pre-paint attribute set by
 * `public/theme-init.js`.
 */
export function usePersistedTheme(): readonly [Theme, (t: Theme) => void] {
  return usePersistedState<Theme>(KEY, "light", isTheme, (t) =>
    document.documentElement.setAttribute("data-theme", t),
  );
}
