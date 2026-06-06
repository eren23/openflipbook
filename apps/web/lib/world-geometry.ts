import type {
  MapCrop,
  ObserverPose,
  ProjectedEntity,
  WorldEntityGeo,
} from "@openflipbook/config";

/**
 * Pure 2.5D projection: (world map + observer pose) → per-frame entity layout.
 *
 * A flat-ground bearing/size approximation, NOT a full 3D camera. Output is
 * coarse bins (h_pos/v_pos/size) plus 0..1 normalized rects — what prompts and
 * the VLM judge consume (honest: bins, not pixels). LIMITS: no tall-building
 * vertical perspective, no terrain elevation, no interiors/occlusion-by-walls.
 *
 * Kept line-for-line identical to the Python port
 * apps/modal-backend/providers/geometry.py; the P1 parity gate (a shared golden
 * fixture both must reproduce) guards drift. World coords: origin top-left, +x
 * east, +y south. `gaze` is a heading in radians (0 = +x); `fov` is horizontal.
 */

// Minimal shape the projector needs (WorldEntityGeo satisfies it).
export type ProjectInput = Pick<
  WorldEntityGeo,
  "id" | "label" | "pos" | "height" | "footprint"
>;

const TWO_PI = 2.0 * Math.PI;

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
  const thBase = Math.atan((0.0 - eye) / dist);
  const thTop = Math.atan((entity.height - eye) / dist);
  const yBase = 0.5 - Math.tan(thBase) / (2.0 * tv);
  const yTop = 0.5 - Math.tan(thTop) / (2.0 * tv);
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

export function cropEntities(
  entities: ProjectInput[],
  crop: MapCrop,
): ProjectInput[] {
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
