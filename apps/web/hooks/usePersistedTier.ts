"use client";

import { useEffect, useRef, useState } from "react";
import type { ImageTier, VideoTier } from "@openflipbook/config";

const IMAGE_TIER_KEY = "openflipbook.tier";
const VIDEO_TIER_KEY = "openflipbook.videoTier";

function isTier(v: unknown): v is "fast" | "balanced" | "pro" {
  return v === "fast" || v === "balanced" || v === "pro";
}

/**
 * Image tier persisted to localStorage. The first effect run after mount is
 * skipped so we don't clobber a fresh hydration with the default value before
 * the load-from-storage effect runs.
 */
export function useImageTier(): readonly [ImageTier, (t: ImageTier) => void] {
  const [tier, setTier] = useState<ImageTier>("balanced");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(IMAGE_TIER_KEY);
    if (isTier(stored)) setTier(stored);
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(IMAGE_TIER_KEY, tier);
  }, [tier]);

  // One-time warning when switching to pro. Tier-specific concern; lives here
  // alongside the state so callers don't have to remember to wire it up.
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
  const [tier, setTier] = useState<VideoTier>("fast");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(VIDEO_TIER_KEY);
    if (isTier(stored)) setTier(stored);
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIDEO_TIER_KEY, tier);
  }, [tier]);

  return [tier, setTier] as const;
}
