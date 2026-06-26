"use client";

import { useEffect, useRef } from "react";
import type { ImageTier, VideoTier } from "@openflipbook/config";

import { usePersistedState } from "./usePersistedState";

const IMAGE_TIER_KEY = "openflipbook.tier";
const VIDEO_TIER_KEY = "openflipbook.videoTier";

function isTier(v: unknown): v is "fast" | "balanced" | "pro" {
  return v === "fast" || v === "balanced" || v === "pro";
}

/**
 * Image tier persisted to localStorage, plus a one-time console warning when
 * switching to pro (slower + pricier). The warning lives here, alongside the
 * state, so callers don't have to remember to wire it up.
 */
export function useImageTier(): readonly [ImageTier, (t: ImageTier) => void] {
  const [tier, setTier] = usePersistedState<ImageTier>(IMAGE_TIER_KEY, "balanced", isTier);

  const proWarned = useRef(false);
  useEffect(() => {
    if (tier === "pro" && !proWarned.current) {
      proWarned.current = true;
      console.warn(
        "[openflipbook] pro tier uses a slower + pricier image model — switch back to balanced for snappier exploration.",
      );
    }
  }, [tier]);

  return [tier, setTier] as const;
}

export function useVideoTier(): readonly [VideoTier, (t: VideoTier) => void] {
  return usePersistedState<VideoTier>(VIDEO_TIER_KEY, "fast", isTier);
}
