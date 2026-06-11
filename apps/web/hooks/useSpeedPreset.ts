"use client";

import { useEffect, useRef, useState } from "react";
import type { ImageTier } from "@openflipbook/config";

// The speed preset — one control that bundles {image tier, judged-loop
// attempts, verify} so "I just want it fast and cheap right now" is a single
// tap instead of a server flag. The preset is a SHORTCUT over two stores:
// the image tier keeps living in useImageTier (openflipbook.tier — the
// existing toggle stays the source of truth), this hook owns the loop knobs.
// Both are global localStorage: a per-session preset wrapping a global tier
// would desync the moment you switch sessions.

const KNOBS_KEY = "openflipbook.loopKnobs";

export type SpeedPreset = "fast" | "balanced" | "quality";

export const SPEED_PRESETS: readonly SpeedPreset[] = [
  "fast",
  "balanced",
  "quality",
] as const;

export interface LoopKnobs {
  /** Judged-loop attempts; the server clamps to [1, 4]. */
  maxAttempts: number;
  /** false -> skip the judged loops (a fast, un-judged single shot). */
  verify: boolean;
}

export interface SpeedBundle extends LoopKnobs {
  tier: ImageTier;
}

// The three stops. Balanced is exactly today's defaults — it puts NOTHING
// new on the wire (see wireFields), so the default path stays byte-identical.
export const PRESET_BUNDLES: Record<SpeedPreset, SpeedBundle> = {
  fast: { tier: "fast", maxAttempts: 1, verify: false },
  balanced: { tier: "balanced", maxAttempts: 2, verify: true },
  quality: { tier: "pro", maxAttempts: 3, verify: true },
};

const DEFAULT_KNOBS: LoopKnobs = {
  maxAttempts: PRESET_BUNDLES.balanced.maxAttempts,
  verify: PRESET_BUNDLES.balanced.verify,
};

/** Which preset the current {tier, knobs} amount to — "custom" when the
 * advanced knobs (or a hand-flipped tier) left the three stops. */
export function presetFor(
  tier: ImageTier,
  knobs: LoopKnobs,
): SpeedPreset | "custom" {
  for (const preset of SPEED_PRESETS) {
    const b = PRESET_BUNDLES[preset];
    if (
      b.tier === tier &&
      b.maxAttempts === knobs.maxAttempts &&
      b.verify === knobs.verify
    )
      return preset;
  }
  return "custom";
}

/** The request-body fields the knobs put on the wire. Balanced values are
 * OMITTED (absent -> the backend's env defaults, byte-identical to today). */
export function wireFields(knobs: LoopKnobs): {
  max_attempts?: number;
  verify?: boolean;
} {
  return {
    ...(knobs.maxAttempts !== PRESET_BUNDLES.balanced.maxAttempts
      ? { max_attempts: knobs.maxAttempts }
      : {}),
    ...(knobs.verify ? {} : { verify: false }),
  };
}

function isKnobs(v: unknown): v is LoopKnobs {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.maxAttempts === "number" &&
    k.maxAttempts >= 1 &&
    k.maxAttempts <= 4 &&
    typeof k.verify === "boolean"
  );
}

/**
 * Loop knobs persisted to localStorage; mirrors useImageTier (the first
 * effect run after mount is skipped so a fresh hydration isn't clobbered by
 * the default before the load-from-storage effect runs).
 */
export function useLoopKnobs(): readonly [LoopKnobs, (k: LoopKnobs) => void] {
  const [knobs, setKnobs] = useState<LoopKnobs>(DEFAULT_KNOBS);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(KNOBS_KEY);
    if (!stored) return;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (isKnobs(parsed))
        setKnobs({ maxAttempts: parsed.maxAttempts, verify: parsed.verify });
    } catch {
      // garbage in storage -> keep the default
    }
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KNOBS_KEY, JSON.stringify(knobs));
  }, [knobs]);

  return [knobs, setKnobs] as const;
}
