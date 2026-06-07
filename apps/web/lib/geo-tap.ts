import type {
  MapCrop,
  ProjectedEntity,
  SceneView,
  WorldEntityGeo,
} from "@openflipbook/config";

import { routeClick, type ClickPoint } from "./click-route";
import { projectScene } from "./world-geometry";

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
  return {
    scene_view: {
      node_id: nodeId,
      level: route.level,
      observer: route.observer,
      map_crop: null,
    },
    expected_layout: projectScene(map.entities, route.observer, aspect),
    focus_id: route.focus_id,
  };
}
