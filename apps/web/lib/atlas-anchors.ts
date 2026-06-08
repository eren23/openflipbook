import type { SceneView, WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

import {
  type FrameNode,
  type Neighbor,
  neighborsOf,
  resolveAbsolutePos,
} from "./world-geometry";

export interface TileAnchor {
  // The place this tile entered, in absolute world coords (for a coord label).
  focusWorldPos: WorldVec2;
  // The observer's heading (radians) for a compass tick; null on a map view.
  gazeAngle: number | null;
  // Nearest entities to the focus (for a hover "N of X · Dm" relation list).
  neighbors: Neighbor[];
}

/**
 * Per-tile spatial anchor for the atlas: given the node's saved SceneView + the
 * world geo map, surface where the entered place sits, which way the camera
 * looked, and what's around it. Pure; returns null for tiles with no geometry
 * (classic/pre-geo nodes, or a focus that isn't in the map yet).
 */
export function anchorForTile(
  sceneView: SceneView | null | undefined,
  geoMap: { entities: WorldEntityGeo[] },
  k = 3,
): TileAnchor | null {
  const focusId = sceneView?.focus_id;
  if (!focusId) return null;
  const byId = new Map<string, FrameNode>(geoMap.entities.map((e) => [e.id, e]));
  const focus = byId.get(focusId);
  if (!focus) return null;
  return {
    focusWorldPos: resolveAbsolutePos(focusId, byId) ?? focus.pos,
    gazeAngle: sceneView?.observer?.gaze ?? null,
    neighbors: neighborsOf(geoMap.entities, focusId, k),
  };
}
