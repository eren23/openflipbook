import type {
  MapCrop,
  ObserverPose,
  SceneView,
  ViewLevel,
  WorldEntityGeo,
  WorldMapSnapshot,
  WorldVec2,
} from "@openflipbook/config";

import { cropEntities, projectScene } from "./world-geometry";

/**
 * Pure, coordinate-driven click routing. Given the world map, the current scene
 * view and a normalized click, decide what entering means:
 *   - "scene": the tap landed on an enterable PLACE → stand in front of it and
 *     look at it (the level + observer pose are synthesized from its geometry).
 *   - "submap": the tap landed on empty map area that still holds a cluster →
 *     stay in map mode, crop to a window around it.
 *   - "explainer": nothing spatial to enter → a topical explainer (the old
 *     behaviour), optionally remembering which entity was under the finger.
 *
 * Going-IN auto-detects here; "expand outward" stays an explicit user action
 * elsewhere. Used only when GEOMETRIC_WORLD is on; off → the tap handler keeps
 * its existing path untouched.
 */

export interface ClickPoint {
  x_pct: number;
  y_pct: number;
}

export type ClickRoute =
  // The closeup rung (tap descent ladder): a TIGHT zoom on the tapped place —
  // the high-consistency Kontext continuation, one step closer per tap.
  | { kind: "closeup"; crop: MapCrop; focus_id: string }
  | { kind: "submap"; crop: MapCrop; focus_id: string | null }
  | { kind: "scene"; level: ViewLevel; observer: ObserverPose; focus_id: string }
  | { kind: "explainer"; focus_id: string | null };

// A place at least this tall (world units) enters at "building" level, else "street".
const BUILDING_HEIGHT = 12;
// A submap window spans this fraction of the current crop, centred on the tap.
const SUBMAP_FRACTION = 0.4;
// Fewer than this many entities in the window → not worth a submap (explainer).
const MIN_SUBMAP_ENTITIES = 2;
const EYE_HEIGHT = 1.7;
const DEFAULT_FOV = Math.PI / 2;

export function focusOnMap(
  entities: WorldEntityGeo[],
  crop: MapCrop,
  click: ClickPoint,
): WorldEntityGeo | null {
  const wx = crop.x + click.x_pct * crop.w;
  const wy = crop.y + click.y_pct * crop.h;
  let best: WorldEntityGeo | null = null;
  let bestD = Infinity;
  for (const e of entities) {
    if (
      Math.abs(wx - e.pos.x) <= e.footprint.w / 2 &&
      Math.abs(wy - e.pos.y) <= e.footprint.d / 2
    ) {
      const d = (wx - e.pos.x) ** 2 + (wy - e.pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  return best;
}

function focusInScene(
  entities: WorldEntityGeo[],
  observer: ObserverPose,
  aspect: number,
  click: ClickPoint,
): WorldEntityGeo | null {
  // projectScene is nearest-first, so the first rect that contains the click is
  // the entity drawn on top (closest to the camera) — the one tapped.
  for (const p of projectScene(entities, observer, aspect)) {
    if (
      Math.abs(click.x_pct - p.x_pct) <= p.w_pct / 2 &&
      Math.abs(click.y_pct - p.y_pct) <= p.h_pct / 2
    ) {
      return entities.find((e) => e.id === p.id) ?? null;
    }
  }
  return null;
}

/** Stand off `focus` in the direction of `from` (the current viewer), looking
 *  back at it; tilt up for things much taller than eye level. */
function observerFacing(focus: WorldEntityGeo, from: WorldVec2): ObserverPose {
  const dx = from.x - focus.pos.x;
  const dy = from.y - focus.pos.y;
  const len = Math.hypot(dx, dy);
  // Degenerate (viewer sits on the focus) → default to standing south of it.
  const [ux, uy] = len > 1e-6 ? [dx / len, dy / len] : [0, 1];
  const standoff =
    Math.max(focus.footprint.w, focus.footprint.d, focus.height) * 1.5 + 5;
  const pos: WorldVec2 = {
    x: focus.pos.x + ux * standoff,
    y: focus.pos.y + uy * standoff,
  };
  const gaze = Math.atan2(focus.pos.y - pos.y, focus.pos.x - pos.x);
  const pitch =
    focus.height > EYE_HEIGHT * 3
      ? Math.min(0.4, Math.atan2(focus.height - EYE_HEIGHT, standoff) * 0.5)
      : 0;
  return { pos, eye_height: EYE_HEIGHT, gaze, fov: DEFAULT_FOV, pitch };
}

function cropCentre(crop: MapCrop): WorldVec2 {
  return { x: crop.x + crop.w / 2, y: crop.y + crop.h / 2 };
}

// Closeup sizing: the entity's footprint with breathing room, expressed as a
// FRACTION of the frame on both axes so the crop keeps the frame's aspect
// (the property the submap window and the click crop already have).
const CLOSEUP_MARGIN = 1.6;
// Tiny entities keep enough surroundings for Kontext to anchor against.
// 0.18 → 0.28 (F2, ladder-proof harbor): when the map draws a place as a
// bare ICON on terrain, an 18%-of-frame reference carries so few real
// pixels that the magnification invents architecture around it (the
// lighthouse grew a walled yard). More surrounding map in the reference
// anchors the symbol→building translation to what is actually drawn.
const CLOSEUP_MIN_FRAC = 0.28;
// Big landmarks still deserve a real zoom: the crop caps below the frame so
// the closeup rung always descends. (The proof harness caught a palace whose
// EXTRACTED footprint was 39x33 on the 100x60 frame — margin pushed the crop
// to 88% and the old >=0.85 guard skipped the rung entirely.)
const CLOSEUP_MAX_FRAC = 0.72;
// Skip the rung only when the FOOTPRINT ITSELF effectively fills the frame —
// then a closeup genuinely is a no-op and the tap should enter.
const CLOSEUP_DEGENERATE_FRAC = 0.85;

/** The closeup window for a place: footprint × margin, aspect-preserving,
 *  capped below the frame, clamped inside it. Pure; exported for the
 *  conditioning crop. */
export function entityCloseupCrop(
  focus: WorldEntityGeo,
  frame: MapCrop,
  margin = CLOSEUP_MARGIN,
  minFrac = CLOSEUP_MIN_FRAC,
): MapCrop {
  const frac = Math.min(
    Math.max(
      (focus.footprint.w * margin) / frame.w,
      (focus.footprint.d * margin) / frame.h,
      minFrac,
    ),
    CLOSEUP_MAX_FRAC,
  );
  const w = frame.w * frac;
  const h = frame.h * frac;
  return {
    x: Math.min(Math.max(focus.pos.x - w / 2, frame.x), frame.x + frame.w - w),
    y: Math.min(Math.max(focus.pos.y - h / 2, frame.y), frame.y + frame.h - h),
    w,
    h,
  };
}

/** The scene route for a known focus entity, exactly as a geometric hit on
 *  its footprint would synthesize it. Exported so a tap resolved by NAME (the
 *  map's lettering names a mapped place) can enter that place too. */
export function routeToFocus(
  focus: WorldEntityGeo,
  from: WorldVec2,
): Extract<ClickRoute, { kind: "scene" }> {
  return {
    kind: "scene",
    level: focus.height >= BUILDING_HEIGHT ? "building" : "street",
    observer: observerFacing(focus, from),
    focus_id: focus.id,
  };
}

export function routeClick(
  map: Pick<WorldMapSnapshot, "entities" | "bounds">,
  view: SceneView,
  click: ClickPoint,
  aspect: number,
  // enterDirect (the page passes NEXT_PUBLIC_TAP_ENTER_DIRECT, default ON):
  // a tapped place ENTERS on the first tap — the closeup rung is right-click
  // territory ("Zoom in here"), not the tap default. Absent = the ladder,
  // so the pure function's default stays the historical behavior.
  opts?: { minSubmapEntities?: number; enterDirect?: boolean },
): ClickRoute {
  const { entities } = map;
  const focus = view.observer
    ? focusInScene(entities, view.observer, aspect, click)
    : view.map_crop
      ? focusOnMap(entities, view.map_crop, click)
      : null;

  // A place under the finger → the descent ladder: first a CLOSEUP (the
  // faithful Kontext zoom), and only the tap on the place whose closeup you
  // are already on TRANSITIONS into it (enter). Scene frames (observer set)
  // keep entering directly — scene-level closeups are a later rung.
  // Under enterDirect the rung is skipped outright: tap = enter, one hop.
  if (focus && focus.kind === "place") {
    if (!opts?.enterDirect && view.map_crop && !view.observer) {
      const alreadyCloseup =
        view.closeup === true && view.focus_id === focus.id;
      if (!alreadyCloseup) {
        // Degenerate only when the FOOTPRINT fills the frame (a closeup of
        // the whole frame is a no-op) — a big landmark still gets its zoom
        // via the capped crop.
        const degenerate =
          focus.footprint.w >= view.map_crop.w * CLOSEUP_DEGENERATE_FRAC &&
          focus.footprint.d >= view.map_crop.h * CLOSEUP_DEGENERATE_FRAC;
        if (!degenerate) {
          return {
            kind: "closeup",
            crop: entityCloseupCrop(focus, view.map_crop),
            focus_id: focus.id,
          };
        }
      }
    }
    const from = view.observer?.pos ?? cropCentre(view.map_crop ?? map.bounds);
    return routeToFocus(focus, from);
  }

  // Empty map area that still holds a cluster → crop a submap around it.
  if (!view.observer && view.map_crop) {
    const crop = view.map_crop;
    const wx = crop.x + click.x_pct * crop.w;
    const wy = crop.y + click.y_pct * crop.h;
    const win: MapCrop = {
      x: wx - (crop.w * SUBMAP_FRACTION) / 2,
      y: wy - (crop.h * SUBMAP_FRACTION) / 2,
      w: crop.w * SUBMAP_FRACTION,
      h: crop.h * SUBMAP_FRACTION,
    };
    const minEntities = opts?.minSubmapEntities ?? MIN_SUBMAP_ENTITIES;
    if (cropEntities(entities, win).length >= minEntities) {
      return { kind: "submap", crop: win, focus_id: focus?.id ?? null };
    }
  }

  return { kind: "explainer", focus_id: focus?.id ?? null };
}
