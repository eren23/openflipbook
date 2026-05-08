"use client";

import { useEffect, useState } from "react";

import { emit as hudEmit, nowMs } from "@/lib/trace";

export interface MorphFx {
  ox: number;
  oy: number;
  prevImg: string | null;
  nextImg: string | null;
  phase: "wait" | "reveal";
  isFinal: boolean;
  startedAt: number;
  reduceMotion: boolean;
}

/**
 * Owns the scale-from-origin morph animation state for the page canvas.
 * The flow is: caller sets morphFx={..., phase: "wait"} when a click fires,
 * caller flips `isFinal=true` once the SSE final event lands, this hook
 * decodes the new image off-thread and then transitions phase → "reveal".
 *
 * Decode is critical — without it the new <img> would paint mid-decode and
 * the scale/opacity transition would visibly stutter for ~80–200 ms on
 * large (3+ MB) data URLs. The catch path keeps environments without
 * `Image().decode()` working (less smooth).
 */
export function useImageMorph(currentImageDataUrl: string | null | undefined) {
  const [morphFx, setMorphFx] = useState<MorphFx | null>(null);

  useEffect(() => {
    if (!morphFx || morphFx.phase !== "wait") return;
    if (!morphFx.isFinal) return;
    if (!currentImageDataUrl) return;
    if (currentImageDataUrl === morphFx.prevImg) return;
    let cancelled = false;
    const url = currentImageDataUrl;
    const im = new Image();
    im.decoding = "async";
    im.src = url;
    const decodeStart = nowMs();
    const finish = () => {
      if (cancelled) return;
      hudEmit("image:decode", { ms: nowMs() - decodeStart });
      setMorphFx((prev) =>
        prev && prev.phase === "wait" ? { ...prev, nextImg: url, phase: "reveal" } : prev,
      );
    };
    im.decode().then(finish).catch(finish);
    return () => {
      cancelled = true;
    };
  }, [currentImageDataUrl, morphFx]);

  return { morphFx, setMorphFx } as const;
}
