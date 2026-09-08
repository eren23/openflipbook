import type { Page } from "./session-pages";
import type { TourNode } from "./tour";
import type { SpatialFrame } from "./spatial-transition";

export const SPATIAL_TRANSITIONS_ENABLED = process.env.NEXT_PUBLIC_SPATIAL_TRANSITIONS === "1";

export function spatialPage(page: Page | null): SpatialFrame {
  return { id: page?.nodeId ?? null, parentId: page?.parentId ?? null, image: page?.imageDataUrl ?? "", imageKey: page?.imageKey,
    relation: page?.relation, view: page?.sceneView, context: page?.transitionContext,
    click: page?.clickInParent ? { x_pct: page.clickInParent.xPct, y_pct: page.clickInParent.yPct } : null };
}

export function spatialNode(node: TourNode): SpatialFrame {
  return { id: node.id, parentId: node.parent_id, image: node.image_url, imageKey: node.image_key,
    relation: node.relation, click: node.click_in_parent, view: node.scene_view, context: node.transition_context };
}
