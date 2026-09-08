"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { planSpatialTransition, type ReframePlan, type SpatialFrame } from "@/lib/spatial-transition";

export interface SpatialMotion { plan: ReframePlan; progress: number; width: number; height: number }

export async function decodeSpatialImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Image decode timed out")), 15000); }),
    ]);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Empty image");
    return image;
  } finally { clearTimeout(timer); }
}

/** Latest navigation wins. A failed destination never replaces the current page. */
export function useSpatialNavigation(decode = decodeSpatialImage) {
  const [motion, setMotion] = useState<SpatialMotion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const raf = useRef(0);
  const settle = useRef<((value: boolean) => void) | null>(null);
  const retryRef = useRef<(() => Promise<boolean>) | null>(null);
  const cancel = useCallback(() => {
    token.current++;
    cancelAnimationFrame(raf.current);
    settle.current?.(false);
    settle.current = null;
    retryRef.current = null;
    setMotion(null); setPending(false); setError(null);
  }, []);
  useEffect(() => () => { token.current++; cancelAnimationFrame(raf.current); settle.current?.(false); }, []);

  const navigate = useCallback(async (from: SpatialFrame, to: SpatialFrame, commit: () => void): Promise<boolean> => {
    cancel();
    const current = token.current;
    const alive = () => current === token.current;
    setPending(true);
    retryRef.current = () => navigate(from, to, commit);
    try {
      const destination = await decode(to.image);
      if (!alive()) return false;
      const plan = planSpatialTransition(from, to, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      if (plan.kind === "cut") {
        commit(); setPending(false); retryRef.current = null;
        return true;
      }
      let source: HTMLImageElement;
      try { source = plan.kind === "back" ? destination : await decode(from.image); }
      catch {
        if (!alive()) return false;
        commit(); setPending(false); retryRef.current = null;
        return true;
      }
      if (!alive()) return false;
      const frame = { plan, width: source.naturalWidth, height: source.naturalHeight };
      setMotion({ ...frame, progress: plan.kind === "back" ? 1 : 0 });
      // Back cuts to the real cropped parent before pulling out. Metadata
      // commits at that same cut, not at the end of the reverse reframe.
      if (plan.kind === "back") commit();
      return await new Promise<boolean>(resolve => {
        settle.current = resolve;
        let start: number | null = null;
        const tick = (now: number) => {
          if (!alive()) return;
          start ??= now;
          const elapsed = now - start;
          const p = Math.min(1, elapsed / plan.duration);
          if (elapsed >= plan.duration + plan.hold) {
            if (plan.kind === "forward") commit();
            setMotion(null); setPending(false); retryRef.current = null; settle.current = null;
            resolve(true);
          } else {
            setMotion({ ...frame, progress: plan.kind === "back" ? 1 - p : p });
            raf.current = requestAnimationFrame(tick);
          }
        };
        raf.current = requestAnimationFrame(tick);
      });
    } catch {
      if (alive()) { setMotion(null); setPending(false); setError("Image could not load. Try again."); }
      return false;
    }
  }, [cancel, decode]);
  const retry = useCallback(() => retryRef.current?.(), []);
  return { motion, pending, error, navigate, cancel, retry };
}
