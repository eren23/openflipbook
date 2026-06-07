"use client";

import { useCallback, useEffect, useState } from "react";

import type { Autonomy } from "@openflipbook/config";

export interface WorldModeState {
  enabled: boolean;
  autonomy: Autonomy;
}

const DEFAULT: WorldModeState = { enabled: false, autonomy: "auto" };

function storageKey(sessionId: string): string {
  return `openflipbook.worldMode.${sessionId}`;
}

/**
 * Per-session World Mode preference (off by default), persisted to localStorage
 * and hydrated on mount / sessionId change — mirrors {@link useStyleAnchor}.
 * When off the classic tap=learn experience is unchanged; when on, a tap enters
 * the tapped place and `autonomy` chooses auto (just go) vs semi (ask first).
 */
export function useWorldMode(sessionId: string) {
  const [state, setState] = useState<WorldModeState>(DEFAULT);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey(sessionId));
      if (!raw) {
        setState(DEFAULT);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<WorldModeState>;
      setState({
        enabled: Boolean(parsed.enabled),
        autonomy: parsed.autonomy === "semi" ? "semi" : "auto",
      });
    } catch {
      setState(DEFAULT);
    }
  }, [sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey(sessionId), JSON.stringify(state));
    } catch {
      /* private mode / full disk — accept the loss */
    }
  }, [state, sessionId]);

  const setEnabled = useCallback(
    (enabled: boolean) => setState((s) => ({ ...s, enabled })),
    [],
  );
  const setAutonomy = useCallback(
    (autonomy: Autonomy) => setState((s) => ({ ...s, autonomy })),
    [],
  );

  return {
    enabled: state.enabled,
    autonomy: state.autonomy,
    setEnabled,
    setAutonomy,
  } as const;
}
