"use client";

import { useCallback, useEffect, useState } from "react";

import type { Autonomy } from "@openflipbook/config";

export interface WorldModeState {
  enabled: boolean;
  autonomy: Autonomy;
  // DOM labels: maps render label-free and names overlay in the DOM
  // (MapLabelOverlay) — fixes garbled lettering + clicks landing on text.
  // Seeded by NEXT_PUBLIC_DOM_LABELS (build-time), per-session persisted.
  domLabels: boolean;
}

const DOM_LABELS_DEFAULT = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_DOM_LABELS ?? "").toLowerCase(),
);
// Seed default for NEW sessions (build-time). Graduated to ON (2026-08-21):
// a fresh session starts in world mode; NEXT_PUBLIC_WORLD_MODE=0 at build
// time restores the classic seed. A session's own toggle still wins once
// stored, so nobody's existing session changes underneath them.
const WORLD_DEFAULT = !["0", "false", "no"].includes(
  (process.env.NEXT_PUBLIC_WORLD_MODE ?? "").toLowerCase(),
);

const DEFAULT: WorldModeState = {
  enabled: WORLD_DEFAULT,
  autonomy: "auto",
  domLabels: DOM_LABELS_DEFAULT,
};

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
        enabled:
          typeof parsed.enabled === "boolean" ? parsed.enabled : WORLD_DEFAULT,
        autonomy: parsed.autonomy === "semi" ? "semi" : "auto",
        domLabels:
          typeof parsed.domLabels === "boolean"
            ? parsed.domLabels
            : DOM_LABELS_DEFAULT,
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
  const setDomLabels = useCallback(
    (domLabels: boolean) => setState((s) => ({ ...s, domLabels })),
    [],
  );

  return {
    enabled: state.enabled,
    autonomy: state.autonomy,
    domLabels: state.domLabels,
    setEnabled,
    setAutonomy,
    setDomLabels,
  } as const;
}
