import type { MapCrop, ObserverPose, WorldVec2 } from "@openflipbook/config";

/**
 * Pure top-down overlay projection for the atlas + observer/gaze editor. Maps
 * world coords ⇆ a letterboxed viewport that frames a MapCrop, at
 * a uniform scale. Orientation matches the world: +x east → screen right, +y
 * south → screen down — so a world bearing is the same angle on screen, which is
 * what makes the gaze cone trivial. No engine state; just arithmetic, fully
 * unit-tested so the UI overlay ties to the verified geometry.
 */

export interface ViewBox {
  w: number;
  h: number;
  pad?: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Uniform world→screen scale that fits `crop` inside `view` (minus padding). */
export function viewScale(crop: MapCrop, view: ViewBox): number {
  const pad = view.pad ?? 0;
  return Math.min((view.w - 2 * pad) / crop.w, (view.h - 2 * pad) / crop.h);
}

export function worldToView(p: WorldVec2, crop: MapCrop, view: ViewBox): Point {
  const pad = view.pad ?? 0;
  const s = viewScale(crop, view);
  return { x: pad + (p.x - crop.x) * s, y: pad + (p.y - crop.y) * s };
}

export function viewToWorld(px: Point, crop: MapCrop, view: ViewBox): WorldVec2 {
  const pad = view.pad ?? 0;
  const s = viewScale(crop, view);
  return { x: crop.x + (px.x - pad) / s, y: crop.y + (px.y - pad) / s };
}

export interface GazeCone {
  apex: Point;
  left: Point;
  center: Point;
  right: Point;
}

/** The observer's FOV cone in screen coords: apex at the observer, two edge rays
 *  at gaze ± fov/2 and the centre ray, each `lengthPx` long. */
export function gazeConePoints(
  observer: ObserverPose,
  crop: MapCrop,
  view: ViewBox,
  lengthPx: number,
): GazeCone {
  const apex = worldToView(observer.pos, crop, view);
  const half = observer.fov / 2;
  const ray = (ang: number): Point => ({
    x: apex.x + lengthPx * Math.cos(ang),
    y: apex.y + lengthPx * Math.sin(ang),
  });
  return {
    apex,
    left: ray(observer.gaze - half),
    center: ray(observer.gaze),
    right: ray(observer.gaze + half),
  };
}
