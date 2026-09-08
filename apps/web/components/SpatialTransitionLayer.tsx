"use client";

import { useLayoutEffect, useRef, useState } from "react";

import type { SpatialMotion } from "@/hooks/useSpatialNavigation";
import { objectContainRect } from "@/lib/image-click";
import { reframeMatrix } from "@/lib/spatial-transition";

/** Clip to the actual contained image, keeping letterbox bars stationary. */
export function SpatialTransitionLayer({ motion, background = "var(--color-paper, #111)" }: { motion: SpatialMotion | null; background?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const active = !!motion;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  if (!motion) return null;
  const rect = objectContainRect(size.width, size.height, motion.width, motion.height);
  return <div ref={root} data-testid="spatial-transition" data-direction={motion.plan.kind}
    data-progress={motion.progress} aria-hidden="true"
    style={{ position: "absolute", inset: 0, zIndex: 30, overflow: "hidden", background, pointerEvents: "none" }}>
    {rect && <div data-testid="spatial-content" style={{ position: "absolute", overflow: "hidden", left: rect.offsetX, top: rect.offsetY, width: rect.width, height: rect.height }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- exact source pixels; no image optimization */}
      <img src={motion.plan.source.image} alt="" draggable={false}
        style={{ display: "block", width: "100%", height: "100%", maxWidth: "none", transformOrigin: "0 0", transform: reframeMatrix(motion.plan, motion.progress, rect.width, rect.height) }} />
    </div>}
  </div>;
}
