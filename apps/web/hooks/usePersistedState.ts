"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A string-valued preference persisted to localStorage: hydrate-on-mount,
 * write-on-change, and a first-run guard so the effect that fires right after
 * mount doesn't clobber a fresh hydration (or a pre-paint attribute) with the
 * default value. `validate` rejects junk/legacy stored values; the optional
 * `onChange` runs the per-preference side effect (stamp `data-theme`, flip
 * `lang/dir`, …) — also skipped on the first run.
 *
 * Powers usePersistedTheme / usePersistedLocale / useImageTier / useVideoTier;
 * each is a thin wrapper that supplies its key, default, guard, and side effect.
 */
export function usePersistedState<T extends string>(
  key: string,
  fallback: T,
  validate: (v: unknown) => v is T,
  onChange?: (v: T) => void,
): readonly [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(key);
    if (validate(stored)) setValue(stored);
  }, [key, validate]);

  const sideEffect = useRef(onChange);
  sideEffect.current = onChange;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
    sideEffect.current?.(value);
  }, [key, value]);

  return [value, setValue] as const;
}
