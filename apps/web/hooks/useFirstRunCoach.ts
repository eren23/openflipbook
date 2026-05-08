"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "openflipbook.coach.seen";

/**
 * Tracks whether the first-run shortcut coach has been shown for this
 * browser. Persists a one-shot flag in localStorage; once dismissed the
 * coach never reappears for that origin.
 */
export function useFirstRunCoach(): readonly [boolean, () => void] {
  const [seen, setSeen] = useState(true); // default true so SSR doesn't flash

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setSeen(window.localStorage.getItem(KEY) === "1");
    } catch {
      setSeen(true);
    }
  }, []);

  const dismiss = useCallback((): void => {
    setSeen(true);
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      /* private mode — accept the loss */
    }
  }, []);

  return [seen, dismiss] as const;
}
