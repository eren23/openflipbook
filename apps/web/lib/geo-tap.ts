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
  projectScene,
  resolveAbsolutePos,
} from "./world-geometry";

export interface GeoTap {
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
  const byId = new Map(map.entities.map((e) => [e.id, e]));
  const layoutEntities =
    kids.length > 0
      ? kids.map((k) => ({ ...k, pos: resolveAbsolutePos(k.id, byId) ?? k.pos }))
      : [];
  return {
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
