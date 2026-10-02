/**
 * Keyframe maths for painting a saved camera (research 34).
 *
 * A keyframe carries to the next camera by warping, not by reference: the
 * accepted picture at camera A is moved into camera B with both cameras'
 * saved depth, and B's own depth marks what A never saw (the holes, which
 * show B's render and are the only areas the model must invent). The gate
 * then segments the painted result and compares the largest building with
 * the exact object pass. Pure functions over decoded RGBA pixels; decoding
 * and storage live with the caller.
 */
import type { PlaceSceneObject } from "@openflipbook/config";
import type { ViewCamera, ViewCapture } from "./place-view";
import { compareMasks, maskForVisible, type SilhouetteMatch } from "./silhouette";

/** What the warp needs from a saved view or a capture. */
export interface KeyframeView {
  width: number; height: number;
  camera: ViewCamera;
  depth: { near: number; far: number };
}

export interface KeyframeWarp {
  /** B-sized RGBA: A's picture where B sees what A saw, B's render in the holes, A's sky gradient in B's sky. */
  rgba: Uint8Array;
  /** 1 where A gave no evidence and the pixel shows B's render. */
  hole: Uint8Array;
  /** 1 on B's sky (depth 0) painted with A's sky row means. */
  sky: Uint8Array;
  /** Share of B's geometry pixels that are holes. */
  holeShare: number;
  /** Angle between the two eyes, seen from the centre of A's geometry. */
  angleDeg: number;
}

const rgba = (bytes: Uint8Array, width: number, height: number, name: string) => {
  if (bytes.length !== width * height * 4) throw new Error(`${name} must be RGBA at ${width}x${height}`);
};
// Saved-view depth contract (docs/PLACE_VIEWS.md): byte 0 is background or sky.
const distance = (view: KeyframeView, byte: number) => view.depth.near + (1 - byte / 255) * (view.depth.far - view.depth.near);

// Three.js column-major matrices. The world matrix is rigid (the server checks
// it), so camera space is R^T (world - t). Projections have no skew terms.
const toWorld = (m: number[], x: number, y: number, z: number) =>
  [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!] as const;
const toCamera = (m: number[], x: number, y: number, z: number) => {
  x -= m[12]!; y -= m[13]!; z -= m[14]!;
  return [m[0]! * x + m[1]! * y + m[2]! * z, m[4]! * x + m[5]! * y + m[6]! * z, m[8]! * x + m[9]! * y + m[10]! * z] as const;
};
const project = (p: number[], x: number, y: number, z: number) => {
  const w = p[11]! * z + p[15]!;
  return [(p[0]! * x + p[8]! * z + p[12]!) / w, (p[5]! * y + p[9]! * z + p[13]!) / w] as const;
};
const unproject = (p: number[], nx: number, ny: number, z: number) => {
  const w = p[11]! * z + p[15]!;
  return [(nx * w - p[8]! * z - p[12]!) / p[0]!, (ny * w - p[9]! * z - p[13]!) / p[5]!] as const;
};

// ponytail: tunable. Over this many B pixels per A pixel along some direction,
// A saw the surface at a grazing angle (or from much farther): its paint arrives
// stretched into stripes, and the error compounds down a chain, so B paints it.
// The 2x2 splat stays gap-free up to 2x. On the research pair (28 degrees,
// 960 -> 832 px) the grazing back roof measures over 3x, the far ground up to
// about 1.5x, and almost nothing lies between, so 1.6 is not a fine balance.
export const WARP_MAX_MAGNIFICATION = 1.6;
const MAGNIFICATION_STEP = 8;

/** Sum of `mask` over the (2r+1)^2 window at each pixel, clipped to the frame. */
function boxSum(mask: Uint8Array, width: number, height: number, r: number) {
  const s = new Int32Array((width + 1) * (height + 1)), out = new Int32Array(width * height), row = width + 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    s[(y + 1) * row + x + 1] = mask[y * width + x]! + s[y * row + x + 1]! + s[(y + 1) * row + x]! - s[y * row + x]!;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
    out[y * width + x] = s[y1 * row + x1]! - s[y0 * row + x1]! - s[y1 * row + x0]! + s[y0 * row + x0]!;
  }
  return out;
}

/**
 * Warp A's accepted picture into camera B. Each A pixel is unprojected with
 * A's depth and matrices, projected into B, and splatted 2x2. A splat only
 * lands where B's depth agrees within 0.35 m + 2% (otherwise B sees another
 * surface there); a point that falls inside the pixel beats a neighbour's
 * splat, then the nearer point wins. A splat whose source is magnified past
 * `maxMagnification` is dropped (see WARP_MAX_MAGNIFICATION). Cracks with 4+
 * valid neighbours take their mean, and below 60% coverage of B's geometry
 * in a 9x9 window the warp is not evidence (grazing surfaces arrive as
 * sparse stripes). B's sky takes A's sky as a vertical gradient.
 */
export function warpKeyframe(
  a: { view: KeyframeView; image: Uint8Array; depth: Uint8Array },
  b: { view: KeyframeView; render: Uint8Array; depth: Uint8Array },
  maxMagnification = WARP_MAX_MAGNIFICATION,
): KeyframeWarp {
  const { width: wa, height: ha } = a.view, { width: w, height: h } = b.view, n = w * h;
  rgba(a.image, wa, ha, "Keyframe A picture"); rgba(a.depth, wa, ha, "Keyframe A depth");
  rgba(b.render, w, h, "Keyframe B render"); rgba(b.depth, w, h, "Keyframe B depth");
  const Ma = a.view.camera.world_matrix, Pa = a.view.camera.projection_matrix;
  const Mb = b.view.camera.world_matrix, Pb = b.view.camera.projection_matrix;
  const zB = new Float64Array(n), geometry = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (b.depth[t * 4]) { zB[t] = distance(b.view, b.depth[t * 4]!); geometry[t] = 1; }

  const source = new Int32Array(n).fill(-1), sourceZ = new Float64Array(n), inside = new Uint8Array(n);
  const fx = new Float32Array(wa * ha).fill(NaN), fy = new Float32Array(wa * ha).fill(NaN);
  let px = 0, py = 0, pz = 0, points = 0;
  for (let v = 0; v < ha; v++) for (let u = 0; u < wa; u++) {
    const q = v * wa + u, byte = a.depth[q * 4]!;
    if (!byte) continue;
    const z = -distance(a.view, byte), [x, y] = unproject(Pa, (u + 0.5) / wa * 2 - 1, 1 - (v + 0.5) / ha * 2, z);
    const [wx, wy, wz] = toWorld(Ma, x, y, z);
    px += wx; py += wy; pz += wz; points++;
    const [bx, by, bz] = toCamera(Mb, wx, wy, wz), d = -bz;
    if (d <= b.view.camera.near) continue;
    const [nx, ny] = project(Pb, bx, by, bz);
    fx[q] = (nx + 1) / 2 * w; fy[q] = (1 - ny) / 2 * h;
    const ix = Math.floor(fx[q]!), iy = Math.floor(fy[q]!);
    for (let k = 0; k < 4; k++) {
      const tx = ix + (k & 1), ty = iy + (k >> 1);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const t = ty * w + tx, centre = k === 0 ? 1 : 0;
      if (!geometry[t] || Math.abs(d - zB[t]!) > 0.35 + 0.02 * zB[t]!) continue;
      if (source[t]! >= 0 && (centre < inside[t]! || (centre === inside[t] && d >= sourceZ[t]!))) continue;
      source[t] = q; sourceZ[t] = d; inside[t] = centre;
    }
  }
  if (!points) throw new Error("Keyframe A depth has no geometry");

  // Local magnification of A pixel q in B: the largest stretch of the warp's
  // Jacobian, from secants over up to MAGNIFICATION_STEP pixels along A's axes
  // (a long secant averages out 8-bit depth stairs). A walk stops before a
  // depth edge (one step over twice the limit) and each axis keeps its shorter
  // side, so an edge is not a stretch; with edges on both sides, the edge step counts.
  const jump = 2 * maxMagnification;
  const axis = (q: number, du: number, dv: number): [number, number] => {
    const u = q % wa, v = (q - u) / wa;
    let best: [number, number] = [0, 0], length = Infinity, edge = 0;
    for (const s of [1, -1]) {
      let end = q, j = 0;
      for (; j < MAGNIFICATION_STEP; j++) {
        const u2 = u + du * s * (j + 1), v2 = v + dv * s * (j + 1), next = v2 * wa + u2;
        if (u2 < 0 || v2 < 0 || u2 >= wa || v2 >= ha || Number.isNaN(fx[next]!)) break;
        const step = Math.hypot(fx[next]! - fx[end]!, fy[next]! - fy[end]!);
        if (step > jump) { if (!j) edge = step; break; }
        end = next;
      }
      const dx = (fx[end]! - fx[q]!) / j, dy = (fy[end]! - fy[q]!) / j;
      if (j && dx * dx + dy * dy < length) { best = [dx, dy]; length = dx * dx + dy * dy; }
    }
    return length < Infinity ? best : [edge, 0];
  };
  const magnification = (q: number) => {
    const [p, r] = axis(q, 1, 0), [s, t] = axis(q, 0, 1);
    const f = p * p + r * r + s * s + t * t, det = p * t - r * s;
    return Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2);
  };
  for (let t = 0; t < n; t++) if (source[t]! >= 0 && magnification(source[t]!) > maxMagnification) source[t] = -1;

  const out = new Uint8Array(n * 4), valid = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (source[t]! >= 0) { out.set(a.image.subarray(source[t]! * 4, source[t]! * 4 + 4), t * 4); valid[t] = 1; }
  for (let pass = 0; pass < 3; pass++) {
    const grow: [number, number, number, number][] = [];
    for (let t = 0; t < n; t++) {
      if (valid[t] || !geometry[t]) continue;
      const x = t % w, y = (t - x) / w;
      let c = 0, r = 0, g = 0, bl = 0;
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
        const s = j * w + i;
        if (valid[s]) { c++; r += out[s * 4]!; g += out[s * 4 + 1]!; bl += out[s * 4 + 2]!; }
      }
      if (c >= 4) grow.push([t, r / c, g / c, bl / c]);
    }
    for (const [t, r, g, bl] of grow) { out.set([Math.round(r), Math.round(g), Math.round(bl), 255], t * 4); valid[t] = 1; }
  }
  const covered = boxSum(valid, w, h, 4), surface = boxSum(geometry, w, h, 4);
  for (let t = 0; t < n; t++) if (valid[t] && covered[t]! < 0.6 * surface[t]!) valid[t] = 0;

  // Sky: every B sky pixel takes the mean of A's sky in the proportional row
  // (rows without A sky take the nearest row with it), so a chain keeps one
  // smooth sky. A painted silhouette can stand a few pixels off A's geometry,
  // so A's sky within 1% of the frame of it does not count. Without A sky,
  // B's sky is a hole.
  const nearA = boxSum(a.depth.filter((_, i) => i % 4 === 0).map(v => (v ? 1 : 0)), wa, ha, Math.ceil(0.01 * Math.max(wa, ha)));
  const rows = new Float64Array(ha * 4);
  for (let q = 0; q < wa * ha; q++) if (!nearA[q]) {
    const v = Math.floor(q / wa);
    for (let c = 0; c < 3; c++) rows[v * 4 + c]! += a.image[q * 4 + c]!;
    rows[v * 4 + 3]!++;
  }
  const skyColours = Array.from({ length: h }, (_, y) => {
    const v = Math.floor((y + 0.5) * ha / h);
    for (let d = 0; d < ha; d++) for (const r of [v - d, v + d]) {
      const count = r >= 0 && r < ha ? rows[r * 4 + 3]! : 0;
      if (count) return [Math.round(rows[r * 4]! / count), Math.round(rows[r * 4 + 1]! / count), Math.round(rows[r * 4 + 2]! / count), 255];
    }
    return null;
  });
  const hole = new Uint8Array(n), sky = new Uint8Array(n);
  let holes = 0, surfacePixels = 0;
  for (let t = 0; t < n; t++) {
    if (geometry[t]) { surfacePixels++; if (valid[t]) continue; }
    else {
      const colour = skyColours[Math.floor(t / w)];
      if (colour) { out.set(colour, t * 4); sky[t] = 1; continue; }
    }
    hole[t] = 1; if (geometry[t]) holes++;
    out.set(b.render.subarray(t * 4, t * 4 + 4), t * 4);
  }

  const cx = px / points, cy = py / points, cz = pz / points;
  const ea = [Ma[12]! - cx, Ma[13]! - cy, Ma[14]! - cz], eb = [Mb[12]! - cx, Mb[13]! - cy, Mb[14]! - cz];
  return { rgba: out, hole, sky, holeShare: surfacePixels ? holes / surfacePixels : 0, angleDeg: eyeAngle(ea, eb) };
}

/** Angle in degrees between two eyes, each given relative to the same centre. */
export function eyeAngle(ea: readonly number[], eb: readonly number[]) {
  const cos = (ea[0]! * eb[0]! + ea[1]! * eb[1]! + ea[2]! * eb[2]!) / (Math.hypot(...ea) * Math.hypot(...eb));
  return Math.acos(Math.min(1, Math.max(-1, cos))) * 180 / Math.PI;
}

export interface GateTruth {
  object_id: string;
  /** 0/1 mask of the object's visible pixels in the object pass. */
  mask: Uint8Array;
  /** Pixel bounds as frame fractions [x0, y0, x1, y1], ends exclusive. */
  box: [number, number, number, number];
}

const BUILDING_KINDS = new Set<PlaceSceneObject["kind"]>(["building", "tavern", "house"]);
const isBuilding = (o: Pick<PlaceSceneObject, "kind" | "mesh_role">) => BUILDING_KINDS.has(o.kind) || (o.kind === "mesh" && o.mesh_role === "exterior");

/**
 * The gate's ground truth: the largest visible building in the object pass,
 * if it covers at least 1% of the frame. `table` is the view's ID colour
 * table; `scene` is the saved geometry's objects (for their kinds).
 */
export function gateTruth(objects: Uint8Array, width: number, height: number, table: ViewCapture["objects"],
  scene: readonly Pick<PlaceSceneObject, "id" | "kind" | "mesh_role">[]): GateTruth | null {
  rgba(objects, width, height, "Object pass");
  const buildings = new Set(scene.filter(isBuilding).map(o => o.id)), rows = table.filter(o => buildings.has(o.object_id));
  const index = new Map(rows.map((o, i) => [o.rgb[0] * 65536 + o.rgb[1] * 256 + o.rgb[2], i]));
  const ids = new Int32Array(width * height).fill(-1), counts = new Int32Array(rows.length);
  for (let p = 0; p < ids.length; p++) {
    const i = index.get(objects[p * 4]! * 65536 + objects[p * 4 + 1]! * 256 + objects[p * 4 + 2]!);
    if (i !== undefined) { ids[p] = i; counts[i]!++; }
  }
  let best = -1;
  for (let i = 0; i < counts.length; i++) if (best < 0 || counts[i]! > counts[best]!) best = i;
  if (best < 0 || counts[best]! < 0.01 * ids.length) return null;
  const mask = maskForVisible(ids, best);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) {
    const x = p % width, y = (p - x) / width;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return { object_id: rows[best]!.object_id, mask, box: [x0 / width, y0 / height, x1 / width, y1 / height] };
}

export interface KeyframeGate {
  /** Largest allowed centre offset on each axis, in frame fractions. */
  centre: number;
  /** Allowed painted-over-truth area ratio. */
  area: [number, number];
  /** Smallest mean RGB change (0-255) over render-derived pixels that counts as painted. */
  minPainted: number;
}
// ponytail: minPainted is measured on one research pair (see the stream B report); retune on live receipts.
export const KEYFRAME_GATE: KeyframeGate = { centre: 0.03, area: [0.8, 1.2], minPainted: 12 };

export interface CandidateMetrics { match: SilhouetteMatch | null; painted: number | null; passed: boolean }

/**
 * Gate each candidate's segmenter mask against the truth and pick one. A
 * pass wins; otherwise keep the best: a painted picture over an unpainted
 * one, then the higher overlap. An empty mask is a failed measurement, and a
 * null painted delta means nothing in the input came from the render. A
 * chain passes `agreement` (mean RGB difference from A's warp where A was
 * trusted): it replaces the overlap tie-break, and lower wins, so the chain
 * keeps the painted look of its source.
 */
export function pickCandidate(truth: Uint8Array, candidates: Uint8Array[], painted: (number | null)[],
  width: number, height: number, gate: KeyframeGate = KEYFRAME_GATE, agreement?: (number | null)[]) {
  if (!candidates.length || painted.length !== candidates.length) throw new Error("Each candidate needs a mask and a painted delta");
  let index = 0, best = -Infinity;
  const metrics: CandidateMetrics[] = candidates.map((mask, i) => {
    const match = compareMasks(truth, mask, width, height), delta = painted[i] ?? null;
    const isPainted = delta === null || delta >= gate.minPainted;
    const passed = !!match && isPainted && Math.abs(match.centreDx) <= gate.centre && Math.abs(match.centreDy) <= gate.centre
      && match.areaRatio >= gate.area[0] && match.areaRatio <= gate.area[1];
    const agrees = agreement?.[i] ?? null;
    const score = (passed ? 10 : 0) + (isPainted ? 5 : 0) + (agrees === null ? match?.iou ?? -1 : 1 - agrees / 255);
    if (score > best) { best = score; index = i; }
    return { match, painted: delta, passed };
  });
  return { index, passed: metrics[index]!.passed, metrics };
}

/** Mean absolute RGB change (0-255) over the render-derived pixels; null when there are none. */
export function paintedDelta(render: Uint8Array, candidate: Uint8Array, renderMask: Uint8Array): number | null {
  if (render.length !== renderMask.length * 4 || candidate.length !== render.length) throw new Error("Render, candidate and mask sizes differ");
  let sum = 0, pixels = 0;
  for (let p = 0; p < renderMask.length; p++) {
    if (!renderMask[p]) continue;
    pixels++;
    for (let c = 0; c < 3; c++) sum += Math.abs(render[p * 4 + c]! - candidate[p * 4 + c]!);
  }
  return pixels ? sum / (pixels * 3) : null;
}

/**
 * A chained keyframe: A's warped painting where B sees what A saw, A's sky
 * gradient over all of B's sky, and B's own painting in the holes. The hole edge is blended
 * linearly over 2 px each side, so warp jaggies do not show. `share` is the
 * fraction of the picture that came from the candidate.
 */
export function compositeChain(warp: Pick<KeyframeWarp, "rgba" | "hole">, candidate: Uint8Array, width: number, height: number) {
  rgba(warp.rgba, width, height, "Keyframe warp"); rgba(candidate, width, height, "Keyframe candidate");
  const holes = boxSum(warp.hole, width, height, 2), window = boxSum(new Uint8Array(width * height).fill(1), width, height, 2);
  const out = new Uint8Array(candidate.length);
  let share = 0;
  for (let t = 0; t < holes.length; t++) {
    const a = holes[t]! / window[t]!;
    share += a;
    for (let c = 0; c < 4; c++) out[t * 4 + c] = Math.round(warp.rgba[t * 4 + c]! * (1 - a) + candidate[t * 4 + c]! * a);
  }
  return { rgba: out, share: share / holes.length };
}
