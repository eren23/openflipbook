import type { Citation, NodeRelation, SceneView } from "@openflipbook/config";

/** The in-session page graph node (play page state + history + map views). */
export interface Page {
  nodeId: string | null;
  sessionId: string;
  query: string;
  title: string;
  imageDataUrl: string | null;
  // Set when this page was generated as a child of another via a tap.
  parentId?: string | null;
  // Where the user clicked on the parent page (0..1). Used by the map
  // view to position the child tile inside the parent's rect.
  clickInParent?: { xPct: number; yPct: number };
  // Web-search citations the planner used. Hydrated from the SSE final
  // event and from /api/nodes/[id] on permalink replay. Empty when web
  // search returned nothing or is disabled.
  sources?: Citation[];
  // The view this page was entered from (geo tap). Its focus_id scopes the
  // minimap to the place you're inside; null/absent on the world map + classic
  // pages → the minimap shows the whole world frame.
  sceneView?: SceneView | null;
  // Whether entity extraction has already run for this node (read back from
  // Mongo on revisit/reload). Gates the auto-localize effect so a revisit never
  // silently re-runs the non-deterministic VLM pass. Absent on freshly-created
  // pages this session → the in-memory attempt guard covers them instead.
  geoExtracted?: boolean;
  // How this page hangs off its parent ("expand" = bloomed neighbour,
  // "edit" = revision, "ascend" = OUTWARD container). Absent = descend (a
  // tap-in / fresh page) — same default the server applies on the wire, so
  // the in-session map/minimap read breadth vs depth like the atlas does.
  relation?: NodeRelation;
}

/** One node as served by GET /api/sessions/[id] (the ?continue= hydration). */
export interface SessionNodeWire {
  id: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_url: string;
  click_in_parent: { x_pct: number; y_pct: number } | null;
  sources?: { url: string; title: string | null }[] | null;
  scene_view?: SceneView | null;
  geo_extracted?: boolean;
  // Optional for back-compat with servers that predate the field; the node
  // rows always carry it in Mongo (defaulted "descend" by toRow).
  relation?: NodeRelation;
}

/** Fold the SSE final's scene_view stamp over the request's scene_view.
 * INTERIOR_ENTERS arrivals (#161) stamp the final event with a Partial
 * (scale_tier "room" + place_form "interior"); the client persists the
 * REQUEST's scene_view, so without this fold the stamp never reaches page
 * state or the saved node. Stamp absent → prior unchanged (byte-identical
 * to pre-stamp behavior).
 *
 * Prior null: live-caught (Oakhaven receipts) — a descent-ladder TRANSITION
 * enter sends no scene_view, so the old "prior null → null" silently dropped
 * the interior stamp and the persisted node hydrated unmarked. An interior
 * arrival is self-describing: mint the minimal eye-level frame from the
 * stamp instead. Non-interior stamps without a frame still fold to null
 * (nothing to anchor). node_id is stamped by the callers (post-save). */
export function foldSceneViewStamp(
  prior: SceneView | null | undefined,
  stamp: Partial<SceneView> | null | undefined,
): SceneView | null {
  if (!stamp) return prior ?? null;
  if (!prior) {
    if (stamp.place_form !== "interior") return null;
    return {
      node_id: stamp.node_id ?? "",
      level: "eye",
      observer: null,
      map_crop: null,
      ...stamp,
    };
  }
  return { ...prior, ...stamp };
}

/** Server node row → in-session Page, for ?continue= hydration. */
export function nodeToPage(n: SessionNodeWire): Page {
  return {
    nodeId: n.id,
    sessionId: n.session_id,
    query: n.query,
    title: n.page_title,
    imageDataUrl: n.image_url,
    parentId: n.parent_id,
    sources: Array.isArray(n.sources) ? n.sources : [],
    sceneView: n.scene_view ?? null,
    geoExtracted: n.geo_extracted ?? false,
    // Explicit "descend" rides through too (not collapsed to absent) — the
    // atlas gets the same concrete value off NodeRow, and world-layout keys
    // its zoom-in nesting shrink on the explicit form.
    ...(n.relation ? { relation: n.relation } : {}),
    ...(n.click_in_parent
      ? {
          clickInParent: {
            xPct: n.click_in_parent.x_pct,
            yPct: n.click_in_parent.y_pct,
          },
        }
      : {}),
  };
}
