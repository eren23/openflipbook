"use client";

import { useEffect, useRef, useState } from "react";

export type Theme = "light" | "sepia" | "dark";
export const THEMES: readonly Theme[] = ["light", "sepia", "dark"] as const;

const KEY = "openflipbook.theme";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "sepia" || v === "dark";
}

/**
 * Theme preference persisted to localStorage and reflected onto the
 * `<html data-theme>` attribute. The first run is skipped to avoid
 * overwriting the pre-paint attribute set by `public/theme-init.js`.
 */
export function usePersistedTheme(): readonly [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(KEY);
    if (isTheme(stored)) setTheme(stored);
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return [theme, setTheme] as const;
}
