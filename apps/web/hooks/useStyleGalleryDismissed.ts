"use client";

import { useCallback, useEffect, useState } from "react";

function storageKey(sessionId: string): string {
  return `openflipbook.styleGallery.dismissed.${sessionId}`;
}

/**
 * Tracks whether the user explicitly skipped/picked-from the style gallery.
 * Persisted to sessionStorage so a "Skip" survives reload within the same
 * browser session — but new browser sessions / new tabs see the gallery
 * again. The pinned-preset path writes the actual functional style anchor
 * via useStyleAnchor; this hook only suppresses an empty-state prompt, so
 * the lighter persistence is appropriate.
 */
export function useStyleGalleryDismissed(sessionId: string) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setDismissed(window.sessionStorage.getItem(storageKey(sessionId)) === "1");
    } catch {
      /* private mode / disabled storage — accept the default */
    }
  }, [sessionId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(storageKey(sessionId), "1");
    } catch {
      /* full disk / private mode — accept the loss */
    }
  }, [sessionId]);

  return [dismissed, dismiss] as const;
}
