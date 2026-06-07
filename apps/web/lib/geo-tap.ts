import type {
  MapCrop,
  ProjectedEntity,
  SceneView,
  WorldEntityGeo,
} from "@openflipbook/config";

import { routeClick, type ClickPoint } from "./click-route";
import {
  childrenOf,
  projectScene,
  resolveAbsolutePos,
} from "./world-geometry";

export interface GeoTap {
  scene_view: SceneView;
  expected_layout: ProjectedEntity[];
  focus_id: string | null;
}

/**
 * Close the loop (the plan's "tap a building → enter it geometrically"): given
 * the top-down world map + a normalized tap, route the click → an observer pose,
 * then project the in-frame entities into an `expected_layout` the generator
 * steers by (P3) and the grounding loop audits against (P4).
 *
 * Returns null when the tap doesn't resolve to an enterable scene (empty world,
 * or a submap/explainer tap) — the caller then falls back to the existing World
 * Mode path. Pure: a thin compose over the tested routeClick + projectScene.
 */
export function geoTapRequest(
  map: { entities: WorldEntityGeo[]; bounds: MapCrop },
  nodeId: string,
  click: ClickPoint,
  aspect: number,
): GeoTap | null {
  if (map.entities.length === 0) return null;
  // The current view is the top-down world map (the world's coordinate frame).
  const mapView: SceneView = {
    node_id: nodeId,
    level: "map",
    observer: null,
    map_crop: map.bounds,
  };
  const route = routeClick(map, mapView, click, aspect);
  if (route.kind !== "scene") return null;

  // An entered scene shows the place's INTERIOR, never the city around it.
  //   - Re-enter (P7c): we have the saved interior — its sub-entities seeded into
  //     the child frame on a prior visit — so steer by THOSE (resolved local →
  //     absolute) and the inside stays consistent across visits.
  //   - First enter: we know nothing inside yet, so steer by NOTHING and let the
  //     model render the place freely. Projecting the city's *other* landmarks
  //     here is exactly what wrongly drew the Brass Bridge inside the University
  //     (user-reported "parts outside my image shown in my image"). The child
  //     frame still seeds from this scene's extraction (keyed on focus_id below).
  const kids = childrenOf(map.entities, route.focus_id);
  const byId = new Map(map.entities.map((e) => [e.id, e]));
  const layoutEntities =
    kids.length > 0
      ? kids.map((k) => ({ ...k, pos: resolveAbsolutePos(k.id, byId) ?? k.pos }))
      : [];
  return {
    scene_view: {
      node_id: nodeId,
      level: route.level,
      observer: route.observer,
      map_crop: null,
      // The place you entered: its geo id anchors the child frame the entered
      // scene's sub-entities seed into (P7b).
      focus_id: route.focus_id,
    },
    expected_layout: projectScene(layoutEntities, route.observer, aspect),
    focus_id: route.focus_id,
  };
}
