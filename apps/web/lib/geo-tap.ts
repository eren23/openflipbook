import type {
  MapCrop,
  ObserverPose,
  ProjectedEntity,
  ScaleTier,
  SceneView,
  ViewLevel,
  ViewSpec,
  WorldEntityGeo,
} from "@openflipbook/config";
import { finerTier } from "@openflipbook/config";

import { clamp01 } from "./clamp";
import { routeClick, routeToFocus, type ClickPoint } from "./click-route";
import {
  childrenOf,
  cropEntities,
  projectScene,
  resolveAbsolutePos,
  toAbsoluteEntities,
} from "./world-geometry";

// The image-world frame a top-down map is seeded in: estimateGeoFromBBox maps
// each detection bbox (0..1 of the image) into THIS frame. Tap-routing must use
// the SAME frame so a click on a visible place maps back to that place's coords.
// Routing through the entities' tight bounding box instead lands the click off
// the footprint (the two frames disagree). Kept in lockstep with the extract
// seed (apps/web/app/api/world/[sessionId]/extract/route.ts).
export const MAP_IMAGE_FRAME: MapCrop = { x: 0, y: 0, w: 100, h: 60 };

export interface GeoTap {
  // "scene" = enter a place (perspective, has an observer). "submap" = stay in
  // map mode + crop a region (top-down, no observer). "closeup" = the descent
  // ladder's first rung: a TIGHT zoom on one place (rides the same Kontext
  // continuation as a submap; scene_view.closeup marks the frame).
  kind: "scene" | "submap" | "closeup";
  scene_view: SceneView;
  expected_layout: ProjectedEntity[];
  // The scene's contents (the focus's children, resolved to absolute world
  // coords) — what the detail popover's live preview projects from.
  layout_entities: WorldEntityGeo[];
  focus_id: string | null;
  // Label of the entity you geometrically tapped. Drives the entered scene's
  // subject so a tap on the Tower of Art ENTERS the Tower — not "Unseen
  // University" (its container) that a looser VLM read would pick.
  focus_label: string | null;
  // The focus entity's persistent appearance descriptor — fed (view-neutral) as
  // the authoritative subject context so the entity keeps its IDENTITY (ancient
  // stone, concentric rings, moss-covered) across zoom levels, even as the angle
  // changes between map and scene.
  focus_visual: string | null;
  // Sightline-culled surroundings (scene taps only): `surroundings` becomes
  // VIEW-relative (frame positions from the observer pose) and
  // `surroundings_behind` names the out-of-frustum landmarks the instruction
  // bans from the backdrop. Unset on submap/closeup taps (map register has
  // no camera).
  surroundings_pov?: boolean;
  surroundings_behind?: string;
  // The focus's FRAME-MATES drawn straight from the geo (their real bearings +
  // appearance descriptors), e.g. "to the north-east, The Citadel (square-towered
  // stone bastion on a rise); to the south, The Docks (masted ships)". Fed as the
  // enter's `surroundings` so a stepped-into scene renders the SAME landmarks the
  // map shows, in the right directions — instead of the model reinventing them
  // (nano-banana ignores the image ref on a fresh gen; only text carries this).
  surroundings: string;
}

// Image-frame bearing → a cartographer's cardinal. +x = east, +y = SOUTH (the
// world frame's y grows downward, like the map image).
function cardinal(dx: number, dy: number): string {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  const dirs = [
    "east", "south-east", "south", "south-west",
    "west", "north-west", "north", "north-east",
  ];
  return dirs[Math.round(deg / 45) % 8] ?? "nearby";
}

/** Describe the focus's frame-mates (same parent frame) as visible backdrop —
 *  each with its real bearing from the focus + its appearance — so an entered
 *  scene stays faithful to the map's geography. Pure; empty when the focus has no
 *  mapped neighbours (cold start → the planner's own surroundings stand). */
export function describeSurroundings(
  focusId: string,
  entities: WorldEntityGeo[],
  max = 5,
): string {
  const focus = entities.find((e) => e.id === focusId);
  if (!focus) return "";
  const parent = focus.parent_id ?? null;
  const mates = entities
    .filter(
      (e) => e.id !== focusId && (e.parent_id ?? null) === parent && e.label.trim(),
    )
    .map((m) => ({
      label: m.label.trim(),
      visual: (m.visual ?? "").trim(),
      dir: cardinal(m.pos.x - focus.pos.x, m.pos.y - focus.pos.y),
      // nearest first, so the most relevant backdrop survives the cap
      dist: Math.hypot(m.pos.x - focus.pos.x, m.pos.y - focus.pos.y),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max);
  if (mates.length === 0) return "";
  return (
    mates
      .map((m) => `to the ${m.dir}, ${m.label}${m.visual ? ` (${m.visual})` : ""}`)
      .join("; ") + "."
  );
}

/** Sightline-aware surroundings for an ENTERED scene: the observer pose's view
 *  frustum decides what the camera can actually see. In-frustum frame-mates are
 *  described by their place IN FRAME (left/ahead/right + a distance word, sorted
 *  left-to-right); everything else lands in `behind` — the explicit NOT-visible
 *  list the instruction bans from the backdrop. The live failure this kills: the
 *  lighthouse enter faced open sea, and the bearing-worded neighbours ("to the
 *  east, the docks") were painted into the background anyway. Pure. */
export function describeVisibleSurroundings(
  focusId: string,
  entities: WorldEntityGeo[],
  observer: ObserverPose,
  max = 5,
): { visible: string; behind: string } {
  const focus = entities.find((e) => e.id === focusId);
  if (!focus) return { visible: "", behind: "" };
  const parent = focus.parent_id ?? null;
  const half = (observer.fov > 0 ? observer.fov : Math.PI / 2) / 2;
  // A touch past the frustum edge still reads as "edge of frame".
  const EDGE_PAD = 0.15;
  // Distance words scale with the focus itself (world units are scale-free).
  const unit = Math.max(focus.footprint.w, focus.footprint.d, 8);
  const seen: { label: string; visual: string; angle: number; dist: number }[] = [];
  const hidden: { label: string; dist: number }[] = [];
  for (const m of entities) {
    if (m.id === focusId || (m.parent_id ?? null) !== parent || !m.label.trim()) {
      continue;
    }
    const bearing = Math.atan2(m.pos.y - observer.pos.y, m.pos.x - observer.pos.x);
    let d = bearing - observer.gaze;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const dist = Math.hypot(m.pos.x - observer.pos.x, m.pos.y - observer.pos.y);
    if (Math.abs(d) <= half + EDGE_PAD) {
      seen.push({ label: m.label.trim(), visual: (m.visual ?? "").trim(), angle: d, dist });
    } else {
      hidden.push({ label: m.label.trim(), dist });
    }
  }
  // Screen coords (y down): a positive gaze-relative angle is to the RIGHT.
  seen.sort((a, b) => a.angle - b.angle);
  hidden.sort((a, b) => a.dist - b.dist);
  const side = (a: number): string =>
    a < -half * 0.6
      ? "at the far left of frame"
      : a < -0.2
        ? "ahead to the left"
        : a > half * 0.6
          ? "at the far right of frame"
          : a > 0.2
            ? "ahead to the right"
            : "straight ahead";
  const distWord = (d: number): string =>
    d < unit * 3 ? "close by" : d < unit * 8 ? "in the middle distance" : "far off";
  const visible = seen
    .slice(0, max)
    .map(
      (m) =>
        `${side(m.angle)} ${distWord(m.dist)}, ${m.label}${m.visual ? ` (${m.visual})` : ""}`,
    )
    .join("; ");
  return {
    visible: visible ? visible + "." : "",
    behind: hidden
      .slice(0, 6)
      .map((h) => h.label)
      .join("; "),
  };
}

/**
 * Close the loop (the plan's "tap a building → enter it geometrically"): given
 * the top-down world map + a normalized tap, route the click → an observer pose,
 * then project the in-frame entities into an `expected_layout` the generator
 * steers by and the grounding loop audits against.
 *
 * Returns null when the tap doesn't resolve to an enterable scene (empty world,
 * or a submap/explainer tap) — the caller then falls back to the existing World
 * Mode path. Pure: a thin compose over the tested routeClick + projectScene.
 */
// A user-set view (from the click-detail popover) that overrides the pose +
// level the click router would synthesize, before we enter. `view` is the
// projection pill (2D plan / 2.5D iso / 3D eye): a pinned ViewSpec rides
// scene_view to the backend, beating the view policy (source: "user").
export interface GeoTapOverride {
  observer?: ObserverPose;
  level?: ViewLevel;
  view?: ViewSpec;
}

export function geoTapRequest(
  map: { entities: WorldEntityGeo[]; bounds: MapCrop },
  nodeId: string,
  click: ClickPoint,
  aspect: number,
  override?: GeoTapOverride,
  // The view the tap happened in. At the top-level city map this is absent/map →
  // route over the whole map. INSIDE an entered place, route over THAT place's
  // children so the tap nests one level deeper instead of resolving to a city
  // landmark. Every frame — city or interior — is a top-down map in the SAME
  // MAP_IMAGE_FRAME; the per-frame `scale` composes them to absolute coords.
  currentView?: SceneView | null,
): GeoTap | null {
  if (map.entities.length === 0) return null;
  const insideId =
    currentView && currentView.level !== "map"
      ? currentView.focus_id ?? null
      : null;
  // The entities the tap can land on: the whole map at top level, else the
  // current place's children (in their local frame). At map level, nested
  // entities are RESOLVED to their absolute pos + unit-scaled footprint
  // before hit-testing — raw parent-local coords let a child at local
  // (50,30) shadow a real landmark, and the old top-level-only filter made
  // every entity untappable after an OUTWARD ascend reparented the roots.
  const candidates = insideId
    ? { entities: childrenOf(map.entities, insideId), bounds: map.bounds }
    : {
        entities: toAbsoluteEntities(map.entities, map.entities),
        bounds: map.bounds,
      };
  if (candidates.entities.length === 0) return null;
  // Route the click through the frame the image actually DISPLAYS: a submap/
  // closeup node shows only its crop window, so a click at image centre means
  // the CROP's centre — not the seeded frame's. (Entity seeding and the hover
  // affordance already map through the crop; this restores symmetry.) Top-
  // level maps and entered interiors keep the seeded MAP_IMAGE_FRAME.
  const routingFrame =
    !insideId && currentView?.level === "map" && currentView.map_crop
      ? currentView.map_crop
      : MAP_IMAGE_FRAME;
  const mapView: SceneView = {
    node_id: nodeId,
    level: "map",
    observer: null,
    map_crop: routingFrame,
    // The ladder's transition detection: routeClick enters (instead of
    // closeup-ing again) only when the tap hits the place this frame is
    // already a closeup OF. Plain submaps carry focus_id without closeup.
    ...(currentView?.focus_id ? { focus_id: currentView.focus_id } : {}),
    ...(currentView?.closeup ? { closeup: true } : {}),
  };
  const route = routeClick(candidates, mapView, click, aspect);
  if (route.kind === "explainer") return null;
  const byId = new Map(map.entities.map((e) => [e.id, e]));

  // DEEPER shares ONE ladder with OUTWARD: the entered view sits one rung FINER
  // than the frame you tapped from (a tap = tierStep +1). Stamp it on the entered
  // scene_view so a node's rung is consistent however it was reached. Optional —
  // only when the source frame carries a rung (PR A seeds it).
  const childTier = childTierFor(currentView, byId, route.focus_id ?? null);

  // The descent ladder's first rung: a tight Kontext zoom on the tapped
  // place. Rides the submap machinery (same scene_view shape, same
  // place_submap wire mode) with the closeup flag marking the frame.
  if (route.kind === "closeup") {
    return buildSubmapTap(
      map.entities,
      candidates.entities,
      nodeId,
      route.crop,
      route.focus_id,
      childTier,
      override?.view,
      "closeup",
    );
  }

  // Tap on empty map area that still holds a cluster → stay in MAP mode + crop
  // the region (a sub-map), instead of entering a single place.
  if (route.kind === "submap") {
    return buildSubmapTap(
      map.entities,
      candidates.entities,
      nodeId,
      route.crop,
      route.focus_id,
      childTier,
      override?.view,
    );
  }

  // route.kind === "scene": enter the place.
  // The popover's adjusted pose/level (if any) win over the synthesized ones.
  return buildSceneTap(
    map.entities,
    nodeId,
    route.focus_id,
    override?.observer ?? route.observer,
    override?.level ?? route.level,
    aspect,
    childTier,
    override?.view,
  );
}

function buildSubmapTap(
  allEntities: WorldEntityGeo[],
  candidates: WorldEntityGeo[],
  nodeId: string,
  crop: MapCrop,
  focusId: string | null,
  childTier: ScaleTier | undefined,
  view?: ViewSpec,
  kind: "submap" | "closeup" = "submap",
): GeoTap {
  const byId = new Map(allEntities.map((e) => [e.id, e]));
  return {
    kind,
    scene_view: {
      node_id: nodeId,
      level: "map",
      observer: null,
      map_crop: crop,
      focus_id: focusId,
      ...(kind === "closeup" ? { closeup: true } : {}),
      ...(childTier ? { scale_tier: childTier } : {}),
      ...(view ? { view } : {}),
    },
    expected_layout: [],
    layout_entities: cropEntities(candidates, crop),
    focus_id: focusId,
    focus_label: focusId ? byId.get(focusId)?.label ?? null : null,
    focus_visual: focusId ? byId.get(focusId)?.visual ?? null : null,
    surroundings: focusId ? describeSurroundings(focusId, allEntities) : "",
  };
}

// An entered scene shows the place's INTERIOR, never the city around it.
//   - Re-enter: we have the saved interior — its sub-entities seeded into the
//     child frame on a prior visit — so steer by THOSE (resolved local →
//     absolute) and the inside stays consistent across visits.
//   - First enter: we know nothing inside yet, so steer by NOTHING and let the
//     model render the place freely. Projecting the city's *other* landmarks
//     here is what wrongly draws e.g. the Brass Bridge inside the University
//     ("parts outside my image shown in my image"). The child frame still
//     seeds from this scene's extraction (keyed on focus_id below).
function buildSceneTap(
  allEntities: WorldEntityGeo[],
  nodeId: string,
  focusId: string,
  observer: ObserverPose,
  level: ViewLevel,
  aspect: number,
  childTier: ScaleTier | undefined,
  view?: ViewSpec,
): GeoTap {
  const byId = new Map(allEntities.map((e) => [e.id, e]));
  const kids = childrenOf(allEntities, focusId);
  const layoutEntities =
    kids.length > 0
      ? kids.map((k) => ({ ...k, pos: resolveAbsolutePos(k.id, byId) ?? k.pos }))
      : [];
  const pov = describeVisibleSurroundings(focusId, allEntities, observer);
  return {
    kind: "scene",
    scene_view: {
      node_id: nodeId,
      level,
      observer,
      map_crop: null,
      // The place you entered: its geo id anchors the child frame the entered
      // scene's sub-entities seed into.
      focus_id: focusId,
      ...(childTier ? { scale_tier: childTier } : {}),
      // The projection pill (user-pinned camera) — beats the backend policy.
      ...(view ? { view } : {}),
    },
    expected_layout: projectScene(layoutEntities, observer, aspect),
    layout_entities: layoutEntities,
    focus_id: focusId,
    focus_label: byId.get(focusId)?.label ?? null,
    focus_visual: byId.get(focusId)?.visual ?? null,
    // Sightline-culled: what the observer pose can actually see, not the
    // focus's compass neighbours — see describeVisibleSurroundings.
    surroundings: pov.visible,
    surroundings_pov: true,
    surroundings_behind: pov.behind,
  };
}

/** A frame-coords crop expressed as a normalized box of the DISPLAYED image
 *  (the inverse of the click register): what the canvas crop should cut.
 *  Clamped — submap windows can poke past the frame edge. Pure. */
export function frameCropToImageBox(
  crop: MapCrop,
  frame: MapCrop,
): { x: number; y: number; w: number; h: number } {
  const x = clamp01((crop.x - frame.x) / frame.w);
  const y = clamp01((crop.y - frame.y) / frame.h);
  return {
    x,
    y,
    w: Math.min(clamp01(crop.w / frame.w), 1 - x),
    h: Math.min(clamp01(crop.h / frame.h), 1 - y),
  };
}

/** The conditioning-region decision for a world tap (pure, unit-testable):
 *  closeup/submap → the ROUTING window itself (the reference IS the promise);
 *  a transition tap (entering the place whose closeup fills this frame) → the
 *  WHOLE image as the region; anything else → null (the classic click crop). */
export function regionBoxFor(
  tap: Pick<GeoTap, "kind" | "focus_id" | "scene_view">,
  currentView: SceneView | null | undefined,
):
  | { box: { x: number; y: number; w: number; h: number } }
  | { whole: true }
  | null {
  if (
    (tap.kind === "closeup" || tap.kind === "submap") &&
    tap.scene_view.map_crop
  ) {
    const frame =
      currentView?.level === "map" && currentView.map_crop
        ? currentView.map_crop
        : MAP_IMAGE_FRAME;
    return { box: frameCropToImageBox(tap.scene_view.map_crop, frame) };
  }
  if (
    tap.kind === "scene" &&
    currentView?.closeup === true &&
    currentView.focus_id === tap.focus_id
  ) {
    return { whole: true };
  }
  return null;
}

/** One rung FINER than the frame the tap happened in (see geoTapRequest). */
function childTierFor(
  currentView: SceneView | null | undefined,
  byId: Map<string, WorldEntityGeo>,
  focusId: string | null,
): ScaleTier | undefined {
  const parentTier =
    currentView?.scale_tier ?? byId.get(focusId ?? "")?.scale_tier ?? null;
  return parentTier ? finerTier(parentTier) : undefined;
}

/**
 * W1 degrade net. The geometric route fell through on a map frame (the tap
 * landed on baked-in lettering or unmapped parchment), and the classic
 * fallback would re-compose the scene on the FRESH path — which ignores
 * image refs and is exactly what produced brand-new unrelated pages
 * ("a new city near the river"). Answer instead with the same place_submap
 * zoom-cut a world-mode submap tap rides (Kontext continuation of the
 * region crop): worst case a boring crop, never a reinvention.
 */
export function degradedSubmapTap(
  map: { entities: WorldEntityGeo[]; bounds: MapCrop },
  nodeId: string,
  click: ClickPoint,
  aspect: number,
  currentView?: SceneView | null,
): GeoTap | null {
  if (map.entities.length === 0) return null;
  // Map frames only — inside an entered place the classic tap stands (its
  // frame isn't the map the cut would continue).
  if (currentView && currentView.level !== "map") return null;
  // Same displayed-frame routing as geoTapRequest: a submap node's click
  // coords live in its crop window, not the seeded frame.
  const mapView: SceneView = {
    node_id: nodeId,
    level: "map",
    observer: null,
    map_crop: currentView?.map_crop ?? MAP_IMAGE_FRAME,
  };
  const route = routeClick(map, mapView, click, aspect, {
    minSubmapEntities: 0,
  });
  // A place hit would have routed via geoTapRequest already; anything else
  // on a map frame is a submap window around the tap.
  if (route.kind !== "submap") return null;
  const byId = new Map(map.entities.map((e) => [e.id, e]));
  return buildSubmapTap(
    map.entities,
    map.entities,
    nodeId,
    route.crop,
    route.focus_id,
    childTierFor(currentView, byId, route.focus_id),
  );
}

/**
 * W2 label-click routing. The tap was resolved by NAME — the VLM read the
 * map's baked-in lettering and it matches a mapped place — so enter THAT
 * entity exactly as a geometric hit on its footprint would, observer pose
 * and all. The caller does the matching (entity-label-match.ts).
 */
export function geoTapForEntity(
  map: { entities: WorldEntityGeo[]; bounds: MapCrop },
  nodeId: string,
  entity: WorldEntityGeo,
  aspect: number,
  currentView?: SceneView | null,
): GeoTap {
  const byId = new Map(map.entities.map((e) => [e.id, e]));
  // Stand at the frame centre looking at the place — the same default a
  // footprint hit synthesizes when the viewer has no prior pose.
  const route = routeToFocus(entity, {
    x: MAP_IMAGE_FRAME.x + MAP_IMAGE_FRAME.w / 2,
    y: MAP_IMAGE_FRAME.y + MAP_IMAGE_FRAME.h / 2,
  });
  return buildSceneTap(
    map.entities,
    nodeId,
    route.focus_id,
    route.observer,
    route.level,
    aspect,
    childTierFor(currentView, byId, entity.id),
  );
}

export interface WideRegionCut {
  focus_label: string;
  focus_visual: string | null;
  surroundings: string;
}

/** World-OFF coherence net. A classic tap on a WIDE mapped region (a river, a
 * wall, a district spanning the frame) re-composes the whole scene on the
 * fresh path, and with nothing pinning the geography the model relocates
 * landmarks to fit the new composition — the palace-on-the-riverbank drift.
 * Detect exactly that case and answer with the same place_submap zoom-cut a
 * world-mode submap tap uses (Kontext continuation of the region crop — a
 * faithful CUT of the map, not a reinvention). Narrow entities, nested
 * frames, and unmapped taps all keep the classic topical tap. */
export function wideRegionCut(
  map: { entities: WorldEntityGeo[]; bounds: MapCrop },
  nodeId: string,
  click: ClickPoint,
  aspect: number,
  currentView?: SceneView | null,
  minFrameFrac = 0.5,
): WideRegionCut | null {
  // Only at the top-level map frame — inside an entered place the classic
  // tap stands (its frame isn't the city map the cut would continue).
  if (currentView && currentView.level !== "map") return null;
  const tap = geoTapRequest(map, nodeId, click, aspect, undefined, currentView ?? null);
  if (!tap?.focus_id || !tap.focus_label) return null;
  const focus = map.entities.find((e) => e.id === tap.focus_id);
  if (!focus || (focus.parent_id ?? null) !== null) return null;
  const wide =
    focus.footprint.w >= MAP_IMAGE_FRAME.w * minFrameFrac ||
    focus.footprint.d >= MAP_IMAGE_FRAME.h * minFrameFrac;
  if (!wide) return null;
  return {
    focus_label: tap.focus_label,
    focus_visual: tap.focus_visual,
    surroundings: tap.surroundings,
  };
}
