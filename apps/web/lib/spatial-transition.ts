import type { SceneView, TransitionContextV1 } from "@openflipbook/config";

import { validTransitionPoint } from "./transition-context";
import { REGION_FRAC } from "./image-condition";

export interface SpatialFrame {
  id: string | null;
  parentId: string | null;
  image: string;
  imageKey?: string | undefined;
  relation?: string | null | undefined;
  click?: { x_pct: number; y_pct: number } | null | undefined;
  view?: SceneView | null | undefined;
  context?: TransitionContextV1 | null | undefined;
}

export interface ReframePlan {
  kind: "forward" | "back";
  source: SpatialFrame;
  target: { x_pct: number; y_pct: number };
  fraction: number;
  crop: { x: number; y: number };
  duration: number;
  hold: number;
}
export type SpatialPlan = ReframePlan | { kind: "cut"; reason: string };

/** Screen-space reframing only. Camera snapshots do not imply a 3D route. */
export function planSpatialTransition(from: SpatialFrame, to: SpatialFrame, reducedMotion = false): SpatialPlan {
  if (reducedMotion) return { kind: "cut", reason: "reduced-motion" };
  const forward = !!from.id && to.parentId === from.id;
  const back = !!to.id && from.parentId === to.id;
  if (!forward && !back) return { kind: "cut", reason: "unrelated" };
  const parent = forward ? from : to;
  const child = forward ? to : from;
  if (child.relation && child.relation !== "descend") return { kind: "cut", reason: "unsupported-relation" };
  const context = child.context;
  if (context && (context.version !== 1 || context.source_node_id !== parent.id ||
      !parent.imageKey || context.source_image_key !== parent.imageKey)) {
    return { kind: "cut", reason: "source-mismatch" };
  }
  const point = context ? context.target_point : child.click;
  if (!validTransitionPoint(point)) return { kind: "cut", reason: "unknown-target" };
  const map = (context ? context.source_view : parent.view)?.level === "map";
  const fraction = map ? REGION_FRAC : 1 / 1.35;
  const clamp = (v: number) => Math.min(1 - fraction, Math.max(0, v - fraction / 2));
  return {
    kind: forward ? "forward" : "back", source: parent, target: { ...point },
    fraction, crop: { x: clamp(point.x_pct), y: clamp(point.y_pct) },
    duration: map ? 800 : 450, hold: 100,
  };
}

/** One uniform affine transform for EVERY pixel, in fitted-image coordinates. */
export function sampleReframe(plan: ReframePlan, progress: number) {
  const t = Math.min(1, Math.max(0, progress));
  const ease = t * t * (3 - 2 * t);
  return {
    scale: 1 + (1 / plan.fraction - 1) * ease,
    x: -plan.crop.x / plan.fraction * ease,
    y: -plan.crop.y / plan.fraction * ease,
  };
}

export function reframeMatrix(plan: ReframePlan, progress: number, width: number, height: number): string {
  const m = sampleReframe(plan, progress);
  return `matrix(${m.scale}, 0, 0, ${m.scale}, ${m.x * width}, ${m.y * height})`;
}
