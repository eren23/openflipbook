import type {
  MapCrop,
  ObserverPose,
  ProjectedEntity,
  SceneView,
  ViewLevel,
  WorldEntityGeo,
} from "@openflipbook/config";

import { routeClick, type ClickPoint } from "./click-route";
import {
  childrenOf,
  cropEntities,
  projectScene,
  resolveAbsolutePos,
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
  // map mode + crop a region (top-down, no observer).
  kind: "scene" | "submap";
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
// level the click router would synthesize, before we enter.
export interface GeoTapOverride {
  observer?: ObserverPose;
  level?: ViewLevel;
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
  // current place's children (in their local frame).
  const candidates = insideId
    ? { entities: childrenOf(map.entities, insideId), bounds: map.bounds }
    : map;
  if (candidates.entities.length === 0) return null;
  // Route the click through the image-world frame the entities were SEEDED in —
  // not their tight bounding box (map.bounds), which lands taps off the footprint.
  const mapView: SceneView = {
    node_id: nodeId,
    level: "map",
    observer: null,
    map_crop: MAP_IMAGE_FRAME,
  };
  const route = routeClick(candidates, mapView, click, aspect);
  if (route.kind === "explainer") return null;
  const byId = new Map(map.entities.map((e) => [e.id, e]));

  // Tap on empty map area that still holds a cluster → stay in MAP mode + crop
  // the region (a sub-map), instead of entering a single place.
  if (route.kind === "submap") {
    return {
      kind: "submap",
      scene_view: {
        node_id: nodeId,
        level: "map",
        observer: null,
        map_crop: route.crop,
        focus_id: route.focus_id,
      },
      expected_layout: [],
      layout_entities: cropEntities(candidates.entities, route.crop),
      focus_id: route.focus_id,
      focus_label: route.focus_id ? byId.get(route.focus_id)?.label ?? null : null,
      focus_visual: route.focus_id ? byId.get(route.focus_id)?.visual ?? null : null,
    };
  }

  // route.kind === "scene": enter the place.
  // The popover's adjusted pose/level (if any) win over the synthesized ones.
  const observer = override?.observer ?? route.observer;
  const level = override?.level ?? route.level;

  // An entered scene shows the place's INTERIOR, never the city around it.
  //   - Re-enter: we have the saved interior — its sub-entities seeded into the
  //     child frame on a prior visit — so steer by THOSE (resolved local →
  //     absolute) and the inside stays consistent across visits.
  //   - First enter: we know nothing inside yet, so steer by NOTHING and let the
  //     model render the place freely. Projecting the city's *other* landmarks
  //     here is what wrongly draws e.g. the Brass Bridge inside the University
  //     ("parts outside my image shown in my image"). The child frame still
  //     seeds from this scene's extraction (keyed on focus_id below).
  const kids = childrenOf(map.entities, route.focus_id);
  const layoutEntities =
    kids.length > 0
      ? kids.map((k) => ({ ...k, pos: resolveAbsolutePos(k.id, byId) ?? k.pos }))
      : [];
  return {
    kind: "scene",
    scene_view: {
      node_id: nodeId,
      level,
      observer,
      map_crop: null,
      // The place you entered: its geo id anchors the child frame the entered
      // scene's sub-entities seed into.
      focus_id: route.focus_id,
    },
    expected_layout: projectScene(layoutEntities, observer, aspect),
    layout_entities: layoutEntities,
    focus_id: route.focus_id,
    focus_label: byId.get(route.focus_id)?.label ?? null,
    focus_visual: byId.get(route.focus_id)?.visual ?? null,
  };
}
