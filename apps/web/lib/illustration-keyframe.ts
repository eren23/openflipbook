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
// stretched and soft, and the error compounds down a chain, so B paints it.
// On the research pair (28 degrees, 960 -> 832 px) the grazing back roof and
// gable measure over 4x and the ground 0.8-1.6x (within 1% of the exact plane
// value). Only 1.3% of geometry lies between 1.65 and 4, so 1.6 cuts the far
// ground at the frame edge; raise it into that gap if the cut shows.
export const WARP_MAX_MAGNIFICATION = 1.6;
// Secant and smoothing runs, in B pixels: a long run averages out 8-bit depth stairs.
const DEPTH_RUN = 8;

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
 * 8-bit depth is a staircase: unprojected as is, a sloped surface lands in A
 * in bands, and the texture tears at every step. Each axis in turn takes the
 * mean over a symmetric run of up to DEPTH_RUN pixels each side (NaN is no
 * geometry). The run stops where the depth stops being linear by more than two
 * 8-bit steps (`step` metres), so a plane keeps its slope and a crease or a
 * depth edge stays sharp.
 */
function smoothDepth(z: Float64Array, width: number, height: number, step: number) {
  let out = z;
  for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
    const src = out;
    out = new Float64Array(z.length).fill(NaN);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const t = y * width + x;
      if (Number.isNaN(z[t]!)) continue;
      let sum = src[t]!, count = 1;
      for (let k = 1; k <= DEPTH_RUN; k++) {
        const x0 = x - dx * k, y0 = y - dy * k, x1 = x + dx * k, y1 = y + dy * k, p = y0 * width + x0, q = y1 * width + x1;
        if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height || !(Math.abs(z[p]! + z[q]! - 2 * z[t]!) <= 2 * step)) break;
        sum += src[p]! + src[q]!; count += 2;
      }
      out[t] = sum / count;
    }
  }
  return out;
}

/**
 * Warp A's accepted picture into camera B, backward: each B pixel with
 * geometry is unprojected with B's smoothed depth and matrices, projected
 * into A, and samples A's picture bilinearly over the taps on the same
 * surface. Every B pixel reads A once, so a chain does not alias. A pixel is
 * trusted only when it lands inside A's frame, A's depth there (nearest pixel)
 * agrees within 0.35 m + 2% (otherwise A saw another surface), and one A pixel there covers at most
 * `maxMagnification` B pixels (see WARP_MAX_MAGNIFICATION). B's sky takes A's
 * sky as a vertical gradient.
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
  let px = 0, py = 0, pz = 0, points = 0;
  for (let v = 0; v < ha; v++) for (let u = 0; u < wa; u++) {
    const byte = a.depth[(v * wa + u) * 4]!;
    if (!byte) continue;
    const z = -distance(a.view, byte), [x, y] = unproject(Pa, (u + 0.5) / wa * 2 - 1, 1 - (v + 0.5) / ha * 2, z);
    const [wx, wy, wz] = toWorld(Ma, x, y, z);
    px += wx; py += wy; pz += wz; points++;
  }
  if (!points) throw new Error("Keyframe A depth has no geometry");

  // Where each B surface point lands in A (pixel units), and whether A saw it:
  // inside A's frame, with A's depth there (nearest pixel) on the same surface.
  const zB = new Float64Array(n).fill(NaN);
  for (let t = 0; t < n; t++) if (b.depth[t * 4]) zB[t] = distance(b.view, b.depth[t * 4]!);
  const smooth = smoothDepth(zB, w, h, (b.view.depth.far - b.view.depth.near) / 255), fx = new Float64Array(n).fill(NaN), fy = new Float64Array(n).fill(NaN), seen = new Uint8Array(n), dA = new Float64Array(n);
  const sameSurface = (byte: number, d: number) => byte > 0 && Math.abs(distance(a.view, byte) - d) <= 0.35 + 0.02 * d;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = y * w + x, z = -smooth[t]!;
    if (Number.isNaN(z)) continue;
    const [cx, cy] = unproject(Pb, (x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, z);
    const [ax, ay, az] = toCamera(Ma, ...toWorld(Mb, cx, cy, z)), d = dA[t] = -az;
    if (d <= a.view.camera.near) continue;
    const [nx, ny] = project(Pa, ax, ay, az), u = fx[t] = (nx + 1) / 2 * wa, v = fy[t] = (1 - ny) / 2 * ha;
    if (!(u >= 0 && v >= 0 && u < wa && v < ha)) continue;
    if (sameSurface(a.depth[(Math.floor(v) * wa + Math.floor(u)) * 4]!, d)) seen[t] = 1;
  }

  // B pixels per A pixel at B pixel t, along the worst direction: the inverse
  // of the B -> A Jacobian, from secants over up to DEPTH_RUN pixels along B's
  // axes. A walk may cross surface A did not see (only positions are used) and
  // stops where its step into A changes by more than half: a depth edge, a
  // crease or a fold. Each axis keeps the side with the longer walk, then the
  // shorter secant, so a neighbouring face does not count. A flipped Jacobian
  // is a face A sees from behind: A's depth matched it only within tolerance.
  const axis = (t: number, dx: number, dy: number): [number, number] => {
    const x = t % w, y = (t - x) / w;
    let best: [number, number] = [0, 0], run = 0, length = Infinity;
    for (const s of [1, -1]) {
      let end = t, j = 0, sx = 0, sy = 0;
      for (; j < DEPTH_RUN; j++) {
        const x2 = x + dx * s * (j + 1), y2 = y + dy * s * (j + 1), next = y2 * w + x2;
        if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h || Number.isNaN(fx[next]!)) break;
        const ex = fx[next]! - fx[end]!, ey = fy[next]! - fy[end]!;
        if (j && (ex - sx) ** 2 + (ey - sy) ** 2 > 0.25 * Math.max(ex * ex + ey * ey, sx * sx + sy * sy)) break;
        sx = ex; sy = ey; end = next;
      }
      const ex = (fx[end]! - fx[t]!) / (s * j), ey = (fy[end]! - fy[t]!) / (s * j);
      if (j > run || (j && j === run && ex * ex + ey * ey < length)) { best = [ex, ey]; run = j; length = ex * ex + ey * ey; }
    }
    return best;
  };
  const magnification = (t: number) => {
    const [p, r] = axis(t, 1, 0), [s, q] = axis(t, 0, 1);
    const f = p * p + r * r + s * s + q * q, det = p * q - r * s;
    return det > 0 ? Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2) / det : Infinity;
  };

  // Magnification changes slowly across a surface, so where it crosses the
  // limit, small depth noise would dither the decision into a ragged patchwork
  // of A's and B's paint. Within 10% of the limit, the majority of A's seen
  // pixels in the 9x9 window decides.
  const mag = new Float64Array(n), over = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (seen[t]) { mag[t] = magnification(t); over[t] = mag[t]! > maxMagnification ? 1 : 0; }
  const overs = boxSum(over, w, h, 4), seens = boxSum(seen, w, h, 4);
  const out = new Uint8Array(n * 4), valid = new Uint8Array(n), sum = new Float64Array(4);
  for (let t = 0; t < n; t++) {
    if (!seen[t] || (Math.abs(mag[t]! / maxMagnification - 1) < 0.1 ? 2 * overs[t]! > seens[t]! : over[t])) continue;
    const u = fx[t]!, v = fy[t]!, sx = Math.min(Math.max(u - 0.5, 0), wa - 1), sy = Math.min(Math.max(v - 0.5, 0), ha - 1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, wa - 1), y1 = Math.min(y0 + 1, ha - 1), gx = sx - x0, gy = sy - y0;
    // A tap on another surface (a thin pole's edge against the wall behind it)
    // gets no weight, so neither surface's paint bleeds across the silhouette.
    let total = 0; sum.fill(0);
    for (let k = 0; k < 4; k++) {
      const q = (k < 2 ? y0 : y1) * wa + (k % 2 ? x1 : x0), weight = (k % 2 ? gx : 1 - gx) * (k < 2 ? 1 - gy : gy);
      if (!weight || !sameSurface(a.depth[q * 4]!, dA[t]!)) continue;
      total += weight;
      for (let c = 0; c < 4; c++) sum[c]! += a.image[q * 4 + c]! * weight;
    }
    if (!total) continue;
    for (let c = 0; c < 4; c++) out[t * 4 + c] = Math.round(sum[c]! / total);
    valid[t] = 1;
  }

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
    const geometry = b.depth[t * 4]! > 0;
    if (geometry) { surfacePixels++; if (valid[t]) continue; }
    else {
      const colour = skyColours[Math.floor(t / w)];
      if (colour) { out.set(colour, t * 4); sky[t] = 1; continue; }
    }
    hole[t] = 1; if (geometry) holes++;
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
