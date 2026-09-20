import type { ObserverPose, ProjectedEntity, WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

import { carveLanes } from "./lane-carve";
import { hPos, sizeBin, vPos } from "./world-geometry";

// A camera-view block render of the world map: every solid place extruded to
// its footprint and height, ray-cast from the observer. The flat-coloured
// blocks show the image model WHERE each building is; the per-block visible
// boxes are occlusion-correct, unlike the centre-point projector.

export type LayoutBlock = Pick<WorldEntityGeo, "id" | "label" | "pos" | "footprint" | "height" | "elevation" | "heading" | "parent_id" | "kind">;

// ponytail: label heuristic for ground-level areas the extractor stores as
// "place" (rivers, quays, streets). Upgrade path: a solid/ground field on geos.
const GROUND_LABEL = /\b(river|quay|stream|canal|lake|harbou?r|road|street|avenue|lane|way|square|plaza|bridge|district)\b/i;

/** Solid places in one frame: the siblings under `frameParentId` (null = the
 *  root map). Other frames hold interiors, which would put a room's furniture
 *  on the street. Pass ABSOLUTE entities (toAbsoluteEntities): a zoom-out
 *  re-expresses the town's local numbers under the new parent, but absolute
 *  positions stay put. */
export function solidBlocks<T extends LayoutBlock>(entities: readonly T[], frameParentId: string | null = null): T[] {
  return entities.filter(
    (e) =>
      (e.parent_id ?? null) === frameParentId &&
      e.kind === "place" &&
      e.height > 0.5 &&
      !GROUND_LABEL.test(e.label ?? "") &&
      // One place with a non-finite number poisons every distance taken against
      // it, and a NaN cost loses every comparison silently: the caller ends up
      // with a whole route of NaN, not one bad block. Drop it here, once, for
      // every consumer of this geometry.
      castable(e),
  );
}

/** A heading that is not a number would make every slab test pass. */
const headingOf = (b: LayoutBlock) => (Number.isFinite(b.heading) ? b.heading! : 0);

/** Geometry we can actually measure or cast a ray against. */
function castable(b: LayoutBlock): boolean {
  return Number.isFinite(b.pos?.x) && Number.isFinite(b.pos?.y)
    && Number.isFinite(b.footprint?.w) && Number.isFinite(b.footprint?.d)
    && b.footprint.w > 0 && b.footprint.d > 0
    && Number.isFinite(b.height) && Number.isFinite(b.elevation ?? 0);
}

export function pointInBlock(b: LayoutBlock, p: WorldVec2, margin = 0): boolean {
  const h = headingOf(b);
  const dx = p.x - b.pos.x;
  const dy = p.y - b.pos.y;
  const lx = dx * Math.cos(h) + dy * Math.sin(h);
  const ly = -dx * Math.sin(h) + dy * Math.cos(h);
  return Math.abs(lx) <= b.footprint.w / 2 + margin && Math.abs(ly) <= b.footprint.d / 2 + margin;
}

/** Signed distance from `p` to the block's footprint edge in world units:
 *  positive outside, negative (or 0) inside. Used to keep a camera off walls. */
export function blockDistance(b: LayoutBlock, p: WorldVec2): number {
  const h = headingOf(b);
  const dx = p.x - b.pos.x;
  const dy = p.y - b.pos.y;
  const lx = Math.abs(dx * Math.cos(h) + dy * Math.sin(h)) - b.footprint.w / 2;
  const ly = Math.abs(-dx * Math.sin(h) + dy * Math.cos(h)) - b.footprint.d / 2;
  return lx > 0 || ly > 0 ? Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) : Math.max(lx, ly);
}

export const LAYOUT_COLORS: readonly (readonly [string, readonly [number, number, number]])[] = [
  ["red", [214, 48, 49]],
  ["blue", [41, 98, 214]],
  ["green", [46, 160, 67]],
  ["yellow", [230, 196, 35]],
  ["purple", [136, 68, 190]],
  ["orange", [238, 128, 26]],
  ["cyan", [34, 184, 196]],
  ["pink", [226, 104, 168]],
];
const OTHER: readonly [number, number, number] = [140, 140, 140];
const GROUND: readonly [number, number, number] = [88, 80, 68];
const SKY: readonly [number, number, number] = [238, 238, 238];

export interface LayoutVisible extends ProjectedEntity {
  color: string | null;
  pixels: number;
}

export interface LayoutControl {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  visible: LayoutVisible[];
  /** Distance from the camera to the surface at each pixel, world units;
   *  Infinity where the ray hit sky. Lets one keyframe be warped into the
   *  next camera (research 34) without a 3D scene. */
  depth: Float32Array;
  /** Which entry of `visible` owns each pixel, or -1 for none -- sky, ground,
   *  or a block too small to be named. The renderer already computes this to
   *  draw the boxes; returning it is what lets a caller measure a painted
   *  building against the footprint the map actually stores. */
  ids: Int32Array;
}

export function renderLayoutControl(
  entities: readonly LayoutBlock[],
  observer: ObserverPose,
  width: number,
  height: number,
  frameParentId: string | null = null,
  // Daylight to open between overlapping footprints before drawing. Off for
  // the enter path, which must keep the sizes the map states; a walk through
  // the town needs it, or there is nothing to walk between.
  laneGap: number = 0,
): LayoutControl {
  if (width < 1 || height < 1 || width * height > 4_000_000) throw new Error("Layout render size is out of range");
  // A footprint the camera stands ON (a plaza, a well's square) is ground; a
  // block whose VOLUME contains the camera cannot be drawn from inside, so it
  // is dropped too. Everything else keeps blocking, however low it is.
  const selected = solidBlocks(entities, frameParentId);
  const blocks = (laneGap > 0 ? carveLanes(selected, laneGap) : selected)
    .filter((b) => !(pointInBlock(b, observer.pos) && observer.eye_height < (b.elevation ?? 0) + b.height));
  const g = observer.gaze;
  const p = observer.pitch ?? 0;
  const ox = observer.pos.x;
  const oy = observer.pos.y;
  const oz = observer.eye_height;
  const tanH = Math.tan(observer.fov / 2);
  const tanV = tanH / (width / height);
  const f = [Math.cos(g) * Math.cos(p), Math.sin(g) * Math.cos(p), Math.sin(p)];
  const r = [-Math.sin(g), Math.cos(g), 0];
  const u = [-Math.cos(g) * Math.sin(p), -Math.sin(g) * Math.sin(p), Math.cos(p)];
  const local = blocks.map((b) => {
    const h = headingOf(b);
    const c = Math.cos(h);
    const s = Math.sin(h);
    const dx = ox - b.pos.x;
    const dy = oy - b.pos.y;
    return { c, s, lx: dx * c + dy * s, ly: -dx * s + dy * c, hw: b.footprint.w / 2, hd: b.footprint.d / 2, z0: b.elevation ?? 0, z1: (b.elevation ?? 0) + b.height };
  });
  const hitId = new Int32Array(width * height).fill(-1);
  const shade = new Float32Array(width * height);
  const depth = new Float32Array(width * height).fill(Infinity);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const sy = 1 - ((j + 0.5) / height) * 2;
    for (let i = 0; i < width; i++) {
      const sx = ((i + 0.5) / width) * 2 - 1;
      const dx = f[0]! + sx * tanH * r[0]! + sy * tanV * u[0]!;
      const dy = f[1]! + sx * tanH * r[1]! + sy * tanV * u[1]!;
      const dz = f[2]! + sx * tanH * r[2]! + sy * tanV * u[2]!;
      let best = Infinity;
      let bestK = -1;
      let bestFace = 0;
      for (let k = 0; k < local.length; k++) {
        const b = local[k]!;
        const ldx = dx * b.c + dy * b.s;
        const ldy = -dx * b.s + dy * b.c;
        // Slab test on x, y, z, unrolled: an array here allocates per pixel
        // per block. `face` = axis of the entry plane (0 x, 1 y, 2 z).
        let tMin = 0.05;
        let tMax = best;
        let face = 0;
        let miss = false;
        for (let a = 0; a < 3 && !miss; a++) {
          const o = a === 0 ? b.lx : a === 1 ? b.ly : oz;
          const d = a === 0 ? ldx : a === 1 ? ldy : dz;
          const lo = a === 0 ? -b.hw : a === 1 ? -b.hd : b.z0;
          const hi = a === 0 ? b.hw : a === 1 ? b.hd : b.z1;
          if (Math.abs(d) < 1e-12) {
            miss = o < lo || o > hi;
            continue;
          }
          const t1 = Math.min((lo - o) / d, (hi - o) / d);
          const t2 = Math.max((lo - o) / d, (hi - o) / d);
          if (t1 > tMin) {
            tMin = t1;
            face = a;
          }
          if (t2 < tMax) tMax = t2;
          miss = tMin > tMax;
        }
        if (!miss && tMin < best) {
          best = tMin;
          bestK = k;
          bestFace = face;
        }
      }
      const idx = j * width + i;
      const rayLength = Math.hypot(dx, dy, dz);
      let color: readonly [number, number, number];
      if (bestK >= 0) {
        hitId[idx] = bestK;
        shade[idx] = bestFace === 2 ? 1 : bestFace === 0 ? 0.82 : 0.66;
        depth[idx] = best * rayLength;
        color = OTHER;
      } else if (dz < 0) {
        // The ground plane at the camera's feet: z = 0 along this ray.
        depth[idx] = (oz / -dz) * rayLength;
        color = GROUND;
      } else {
        color = SKY;
      }
      rgba[idx * 4] = color[0];
      rgba[idx * 4 + 1] = color[1];
      rgba[idx * 4 + 2] = color[2];
      rgba[idx * 4 + 3] = 255;
    }
  }
  // Visible boxes from the id buffer, largest first; the biggest 8 get names.
  const stats = blocks.map(() => ({ pixels: 0, x0: width, y0: height, x1: -1, y1: -1 }));
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = hitId[j * width + i]!;
      if (k < 0) continue;
      const st = stats[k]!;
      st.pixels++;
      if (i < st.x0) st.x0 = i;
      if (i > st.x1) st.x1 = i;
      if (j < st.y0) st.y0 = j;
      if (j > st.y1) st.y1 = j;
    }
  }
  const minPixels = Math.max(4, Math.round(width * height * 0.001));
  const order = blocks
    .map((_, k) => k)
    .filter((k) => stats[k]!.pixels >= minPixels)
    .sort((a, b) => stats[b]!.pixels - stats[a]!.pixels || (blocks[a]!.id < blocks[b]!.id ? -1 : 1));
  const colorOf = new Map<number, number>();
  order.slice(0, LAYOUT_COLORS.length).forEach((k, n) => colorOf.set(k, n));
  for (let idx = 0; idx < hitId.length; idx++) {
    const k = hitId[idx]!;
    const n = k >= 0 ? colorOf.get(k) : undefined;
    if (n === undefined) {
      if (k >= 0) {
        rgba[idx * 4] = OTHER[0] * shade[idx]!;
        rgba[idx * 4 + 1] = OTHER[1] * shade[idx]!;
        rgba[idx * 4 + 2] = OTHER[2] * shade[idx]!;
      }
      continue;
    }
    const c = LAYOUT_COLORS[n]![1];
    rgba[idx * 4] = c[0] * shade[idx]!;
    rgba[idx * 4 + 1] = c[1] * shade[idx]!;
    rgba[idx * 4 + 2] = c[2] * shade[idx]!;
  }
  const visible = order.map((k): LayoutVisible => {
    const b = blocks[k]!;
    const st = stats[k]!;
    const w = (st.x1 - st.x0 + 1) / width;
    const h = (st.y1 - st.y0 + 1) / height;
    const xc = (st.x0 + st.x1 + 1) / 2 / width;
    const yc = (st.y0 + st.y1 + 1) / 2 / height;
    const n = colorOf.get(k);
    return {
      id: b.id,
      label: b.label ?? "",
      x_pct: xc,
      y_pct: yc,
      w_pct: w,
      h_pct: h,
      depth: Math.hypot(b.pos.x - ox, b.pos.y - oy),
      h_pos: hPos(xc),
      v_pos: vPos(yc),
      size: sizeBin(Math.max(w, h)),
      color: n === undefined ? null : LAYOUT_COLORS[n]![0],
      pixels: st.pixels,
    };
  });
  // Re-key the id buffer from block index to `visible` index, so a caller can
  // say "the pixels of visible[k]" without knowing the renderer's ordering.
  const visibleIndex = new Map<number, number>();
  order.forEach((k, n) => visibleIndex.set(k, n));
  const ids = new Int32Array(width * height);
  for (let idx = 0; idx < hitId.length; idx++) {
    const k = hitId[idx]!;
    ids[idx] = k >= 0 ? visibleIndex.get(k) ?? -1 : -1;
  }
  return { width, height, rgba, visible, depth, ids };
}
