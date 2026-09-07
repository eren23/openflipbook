import type { EnterAs, RenderMode, SceneView } from "@openflipbook/config";
import { placeViewKind } from "./place-identity";

/**
 * World Mode client helpers (pure).
 *
 * `enterAsToRenderMode` maps the resolver's read of what was tapped onto the
 * planner's render mode. `findRevisitTarget` is the "reopen the same district"
 * check: a re-tap that lands near an existing child's origin reopens that saved
 * node instead of generating a fresh place — the persistence the world needs.
 */

export function enterAsToRenderMode(
  enterAs: EnterAs | string | undefined | null,
): RenderMode {
  if (enterAs === "scene") return "place_scene";
  if (enterAs === "submap") return "place_submap";
  return "explainer";
}

// The context menu's "🔍 Zoom in here": which optical-zoom render mode fits
// the CURRENT frame. An explicit map level — or a ROOT page with no
// scene_view (the classic/session-start map) — zooms as an aligned submap
// cut; everything else zooms as a closeup of what's under the pointer.
//
// Why root-ness matters (video-caught, the enter-and-interiors clip): entered
// pages often carry NO scene_view — ladder TRANSITION enters send none, and
// non-interior arrivals have no stamp to mint one from — so keying on level
// alone read the Astronomer's Study Desk page as a MAP and its "closer look"
// came back as a cartographic redraw of somewhere else. A child page without
// a frame is a place you're AT, not a map you're over.
export function zoomModeForLevel(
  level: string | null | undefined,
  isRootPage = false,
): "place_submap" | "place_closeup" {
  if (level === "map") return "place_submap";
  if (!level && isRootPage) return "place_submap";
  return "place_closeup";
}

export interface RevisitCandidate {
  sceneView?: SceneView | null;
  nodeId: string | null;
  parentId?: string | null;
  clickInParent?: { xPct: number; yPct: number };
}

// How close (normalised image units, euclidean) a re-tap must land to an
// existing child's origin to REOPEN it rather than generate a new place.
export const REVISIT_RADIUS = 0.07;

export function findRevisitTarget(
  items: readonly RevisitCandidate[],
  parentNodeId: string | null,
  click: { x_pct: number; y_pct: number },
  radius: number = REVISIT_RADIUS,
  target?: { geoId: string; kind: string },
): string | null {
  if (!parentNodeId) return null;
  if (target) {
    const saved = items.find(it => it.nodeId && it.sceneView?.focus_id === target.geoId && placeViewKind(it.sceneView) === target.kind);
    if (saved) return saved.nodeId;
  }
  let best: { id: string; d: number } | null = null;
  for (const it of items) {
    if (!it.nodeId || it.parentId !== parentNodeId || !it.clickInParent) continue;
    // Nearby clicks cannot substitute a different known landmark or view.
    if (it.sceneView?.focus_id) continue;
    const dx = it.clickInParent.xPct - click.x_pct;
    const dy = it.clickInParent.yPct - click.y_pct;
    const d = Math.hypot(dx, dy);
    if (d <= radius && (best === null || d < best.d)) best = { id: it.nodeId, d };
  }
  return best ? best.id : null;
}
