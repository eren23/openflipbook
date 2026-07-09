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
  /**
   * True only when the tap is KNOWN to zoom-continue (classifier said
   * scene/submap): the wait phase pushes into the tapped region and the
   * arrival really is that region, closer. Absent/false → shimmer only, so
   * the motion never promises a zoom the fresh path won't deliver.
   */
  dive?: boolean;
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
      // t0 lets the HUD place the decode bar where it actually ran — a
      // backgrounded tab defers this promise by minutes, and without the
      // start time that stall painted as a 100s+ "decode" segment.
      hudEmit("image:decode", { ms: nowMs() - decodeStart, t0: decodeStart });
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
