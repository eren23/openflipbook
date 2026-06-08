import type {
  EntityBBox,
  MapCrop,
  ObserverPose,
  ProjectedEntity,
  SceneView,
  ViewProjection,
  WorldEntityGeo,
  WorldVec2,
} from "@openflipbook/config";

/**
 * Pure 2.5D projection: (world map + observer pose) → per-frame entity layout.
 *
 * A flat-ground bearing/size approximation, NOT a full 3D camera. Output is
 * coarse bins (h_pos/v_pos/size) plus 0..1 normalized rects — what prompts and
 * the VLM judge consume (honest: bins, not pixels). Models the vertical axis via
 * entity `height` + base `elevation` and observer `eye_height` + `pitch` (look
 * up/down). LIMITS: still a flat-ground pinhole — no terrain mesh, no camera
 * roll, no interiors/occlusion-by-walls.
 *
 * Must stay line-for-line identical to the Python port
 * apps/modal-backend/providers/geometry.py: a shared golden fixture both must
 * reproduce guards against drift. World coords: origin top-left, +x east, +y
 * south. `gaze` is a heading in radians (0 = +x); `fov` is horizontal.
 */

// Minimal shape the projector needs (WorldEntityGeo satisfies it).
export type ProjectInput = Pick<
  WorldEntityGeo,
  "id" | "label" | "pos" | "height" | "footprint" | "elevation"
>;

const TWO_PI = 2.0 * Math.PI;
const HALF_PI = Math.PI / 2.0;

function normAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= TWO_PI;
  while (v < -Math.PI) v += TWO_PI;
  return v;
}

function hPos(x: number): string {
  if (x < 0.2) return "far-left";
  if (x < 0.4) return "left";
  if (x < 0.6) return "center";
  if (x < 0.8) return "right";
  return "far-right";
}

function vPos(y: number): string {
  if (y < 0.4) return "top";
  if (y < 0.66) return "mid";
  return "bottom";
}

function sizeBin(s: number): string {
  if (s < 0.08) return "tiny";
  if (s < 0.18) return "small";
  if (s < 0.35) return "medium";
  if (s < 0.6) return "large";
  return "huge";
}

export function project(
  entity: ProjectInput,
  observer: ObserverPose,
  aspect: number,
): ProjectedEntity | null {
  if (aspect <= 0) return null; // degenerate frame — no vertical frustum
  const dx = entity.pos.x - observer.pos.x;
  const dy = entity.pos.y - observer.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null; // degenerate: entity sits on the observer
  const halfFov = observer.fov / 2.0;
  const rel = normAngle(Math.atan2(dy, dx) - observer.gaze);
  if (Math.abs(rel) >= halfFov) return null; // outside the horizontal FOV
  const tHalf = Math.tan(halfFov);
  const xPct = 0.5 + Math.tan(rel) / (2.0 * tHalf);
  // Vertical FOV from the aspect ratio (width / height).
  const halfVfov = Math.atan(tHalf / aspect);
  const tv = Math.tan(halfVfov);
  const eye = observer.eye_height;
  const pitch = observer.pitch ?? 0;
  const elev = entity.elevation ?? 0;
  // Angle (relative to the camera's optical axis) to the entity's base + top:
  // base at world-z = elev, top at elev + height; the camera is tilted by pitch.
  const thBase = Math.atan((elev - eye) / dist) - pitch;
  const thTop = Math.atan((elev + entity.height - eye) / dist) - pitch;
  // Vertical frustum: past ±π/2 the point is behind the image plane (only
  // reachable under pitch / extreme elevation) — cull, mirroring the h-FOV cull.
  if (thTop >= HALF_PI || thBase <= -HALF_PI) return null;
  const yBase = 0.5 - Math.tan(thBase) / (2.0 * tv);
  const yTop = 0.5 - Math.tan(thTop) / (2.0 * tv);
  // Vertical-FOV cull: an entity entirely above/below the frame isn't visible.
  // Without it, an unbounded y_pct lets off-image boxes leak into the
  // projection golden and the grounding diff.
  if (Math.max(yTop, yBase) < 0 || Math.min(yTop, yBase) > 1) return null;
  const yPct = (yTop + yBase) / 2.0;
  const hPct = Math.abs(yBase - yTop);
  const wPct = entity.footprint.w / dist / (2.0 * tHalf);
  return {
    id: entity.id,
    label: entity.label ?? "",
    x_pct: xPct,
    y_pct: yPct,
    w_pct: wPct,
    h_pct: hPct,
    depth: dist,
    h_pos: hPos(xPct),
    v_pos: vPos(yPct),
    size: sizeBin(Math.max(wPct, hPct)),
  };
}

export function projectScene(
  entities: ProjectInput[],
  observer: ObserverPose,
  aspect: number,
): ProjectedEntity[] {
  const out: ProjectedEntity[] = [];
  for (const e of entities) {
    const p = project(e, observer, aspect);
    if (p !== null) out.push(p);
  }
  out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function cropEntities<T extends ProjectInput>(
  entities: T[],
  crop: MapCrop,
): T[] {
  const x1 = crop.x + crop.w;
  const y1 = crop.y + crop.h;
  return entities.filter(
    (e) =>
      e.pos.x >= crop.x && e.pos.x <= x1 && e.pos.y >= crop.y && e.pos.y <= y1,
  );
}

export interface Neighbor {
  id: string;
  bearing: number;
  dist: number;
}

// --- Seeding bridge: extraction bbox → approximate map geometry ---------------
// Back-project an entity's image bbox into world coords so the world map can
// populate from the extraction signal we already produce, without new VLM cost.
// A heuristic, tagged source:"derived" + low confidence by the caller. The MAP
// level is near-exact (a top-down map's bbox maps straight into the crop); the
// perspective levels recover the BEARING exactly but guess the distance (a
// single box is depth-ambiguous), assuming a default real footprint.
export interface GeoEstimate {
  pos: WorldVec2;
  height: number;
  footprint: { w: number; d: number };
}

const DEFAULT_FOOTPRINT = 6;
const DEFAULT_HEIGHT = 4;
// A recovered footprint is clamped to a sane span so a near-frame box on an
// oblique map can't seed a building the size of a district (or smaller than a
// floor tile). Relative units, matching MAP_IMAGE_FRAME's 100×60.
const MAX_FOOTPRINT = 40;
const clampFootprint = (v: number): number =>
  Math.min(Math.max(v, 0.5), MAX_FOOTPRINT);

export function estimateGeoFromBBox(
  bbox: EntityBBox,
  view: SceneView,
  _aspect: number,
  projection: ViewProjection = "top_down",
  // Camera tilt from horizontal, degrees: 0 = horizon, -90 = straight down.
  // Default -60° = the classic bird's-eye, where cos = 0.5.
  pitchDeg = -60,
): GeoEstimate {
  const cx = bbox.x_pct + bbox.w_pct / 2;
  const cy = bbox.y_pct + bbox.h_pct / 2;
  if (view.level === "map" && view.map_crop) {
    const crop: MapCrop = view.map_crop;
    const pos = { x: crop.x + cx * crop.w, y: crop.y + cy * crop.h };
    if (projection !== "top_down") {
      // On a 2.5D / oblique map the box's vertical extent reads as apparent
      // HEIGHT, not footprint depth — so derive a rough, varied height instead
      // of a flat default. Relative, not metric: a detection box wraps a
      // cluster, not one wall. Footprint falls back to a default.
      // The extent reads as TRUE height only when the camera looks
      // near-horizontal. Tilted toward nadir, the extent is mostly roof
      // footprint, so damp it by cos(pitch): 1 at the horizon, 0.5 at the
      // -60deg oblique, ~0 looking straight down (where height-from-extent is
      // meaningless → the default floor kicks in).
      const foreshorten = Math.abs(Math.cos((pitchDeg * Math.PI) / 180));
      // FIX A: the box WIDTH still reads as real ground width on an oblique map,
      // so derive footprint.w from it instead of a flat default; depth (toward
      // the camera) is foreshortened, so damp it off the width by cos(pitch).
      // Still relative, not metric — but a wide building no longer seeds at 6×6,
      // so its map footprint tracks the size it was rendered at.
      const w = clampFootprint(bbox.w_pct * crop.w);
      const d = clampFootprint(w * (0.5 + 0.5 * foreshorten));
      return {
        pos,
        footprint: { w, d },
        height: Math.max(bbox.h_pct * crop.h * foreshorten, DEFAULT_HEIGHT),
      };
    }
    return {
      pos,
      footprint: {
        w: Math.max(bbox.w_pct * crop.w, 0.5),
        d: Math.max(bbox.h_pct * crop.h, 0.5),
      },
      height: DEFAULT_HEIGHT,
    };
  }
  const obs = view.observer;
  if (!obs) {
    return {
      pos: { x: cx, y: cy },
      footprint: { w: DEFAULT_FOOTPRINT, d: DEFAULT_FOOTPRINT },
      height: DEFAULT_HEIGHT,
    };
  }
  // Inverse of project(): x_pct = 0.5 + tan(rel)/(2 tan(halfFov)).
  const halfFov = obs.fov / 2;
  const rel = Math.atan((cx - 0.5) * 2 * Math.tan(halfFov));
  const bearing = obs.gaze + rel;
  // Distance is depth-ambiguous from one box → assume a default real footprint.
  const dist = Math.max(
    DEFAULT_FOOTPRINT / (Math.max(bbox.w_pct, 1e-3) * 2 * Math.tan(halfFov)),
    1,
  );
  return {
    pos: {
      x: obs.pos.x + dist * Math.cos(bearing),
      y: obs.pos.y + dist * Math.sin(bearing),
    },
    footprint: { w: DEFAULT_FOOTPRINT, d: DEFAULT_FOOTPRINT },
    height: DEFAULT_HEIGHT,
  };
}

export function neighborsOf(
  entities: ProjectInput[],
  entityId: string,
  k: number,
): Neighbor[] {
  const src = entities.find((e) => e.id === entityId);
  if (!src) return [];
  const others: Neighbor[] = [];
  for (const e of entities) {
    if (e.id === entityId) continue;
    const dx = e.pos.x - src.pos.x;
    const dy = e.pos.y - src.pos.y;
    others.push({ id: e.id, bearing: Math.atan2(dy, dx), dist: Math.hypot(dx, dy) });
  }
  others.sort(
    (a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return others.slice(0, k);
}

// ── Nested frames ────────────────────────────────────────────────────────────
// A place you ENTER (the Unseen University) is a sub-world: its children carry
// `parent_id` and a pos LOCAL to that frame, so the place's internal layout is
// fixed once and stays consistent across views, and an edit ripples to the
// siblings that share its frame. These pure helpers resolve the hierarchy.

// The frame link is just id + parent (childrenOf/siblingsOf need no geometry);
// resolveAbsolutePos additionally needs the local pos.
export interface FrameLink {
  id: string;
  parent_id?: string | null;
}
export interface FrameNode extends FrameLink {
  pos: WorldVec2;
  // The size of ONE unit of THIS node's interior frame, in its parent's units
  // (default 1). Composes the local→absolute transform with scale, not just
  // translation — so a child's local pos lands at a true absolute position.
  scale?: number;
}

/** Direct children of a place (its sub-entities), stable-sorted by id. */
export function childrenOf<T extends FrameLink>(geos: T[], parentId: string): T[] {
  return geos
    .filter((g) => (g.parent_id ?? null) === parentId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Entities sharing a frame with `id` (same parent), excluding itself — the
 *  "relevant neighbours" an edit ripples to (move one, the others are stale). */
export function siblingsOf<T extends FrameLink>(geos: T[], id: string): T[] {
  const self = geos.find((g) => g.id === id);
  if (!self) return [];
  const parent = self.parent_id ?? null;
  return geos.filter((g) => g.id !== id && (g.parent_id ?? null) === parent);
}

/** Compose the parent chain into an absolute world position — an AFFINE
 *  transform (translation + per-frame scale), cycle-guarded. A node's local
 *  `pos` is in its PARENT's units, so it is added at the cumulative scale of the
 *  ancestors ABOVE it; the node's own `scale` then applies to ITS children. With
 *  every `scale` defaulting to 1 this is byte-identical to plain translation, so
 *  pre-scale data is unaffected. This is what gives every entity BOTH a local
 *  (relative) pos and a true absolute coordinate across the universe. */
export function resolveAbsolutePos(
  id: string,
  byId: Map<string, FrameNode>,
): WorldVec2 | null {
  // Collect self → root (cycle-guarded), then compose root → down.
  const chain: FrameNode[] = [];
  const seen = new Set<string>();
  let node: FrameNode | undefined = byId.get(id);
  if (!node) return null;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    const pid: string | null = node.parent_id ?? null;
    node = pid ? byId.get(pid) : undefined;
  }
  let x = 0;
  let y = 0;
  let scaleAccum = 1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]!;
    x += n.pos.x * scaleAccum;
    y += n.pos.y * scaleAccum;
    scaleAccum *= n.scale ?? 1;
  }
  return { x, y };
}

/** Axis-aligned bounds over entities' OWN pos+footprint (no parent resolve) —
 *  the LOCAL frame of a place's interior, where each child's pos is local. */
export function localBounds<
  T extends { pos: WorldVec2; footprint: { w: number; d: number } },
>(es: T[]): MapCrop {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of es) {
    const hw = e.footprint.w / 2;
    const hd = e.footprint.d / 2;
    minX = Math.min(minX, e.pos.x - hw);
    maxX = Math.max(maxX, e.pos.x + hw);
    minY = Math.min(minY, e.pos.y - hd);
    maxY = Math.max(maxY, e.pos.y + hd);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The larger dimension of a frame's local bounds — "how big is this interior",
 *  used to learn a place's `scale` on first enter (footprint ÷ extent). */
export function localExtent<
  T extends { pos: WorldVec2; footprint: { w: number; d: number } },
>(es: T[]): number {
  if (es.length === 0) return 1;
  const b = localBounds(es);
  return Math.max(b.w, b.h, 1e-6);
}
