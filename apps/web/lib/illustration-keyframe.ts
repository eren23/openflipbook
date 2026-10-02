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
  /** B-sized RGBA: A's picture where B sees what A saw, B's render in the holes, A's sky in the sky. */
  rgba: Uint8Array;
  /** 1 where A gave no evidence and the pixel shows B's render. */
  hole: Uint8Array;
  /** 1 where the pixel is A's sky, carried by rotation only. */
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
const toWorld = (m: number[], x: number, y: number, z: number, w = 1) =>
  [m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w, m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w, m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w] as const;
const toCamera = (m: number[], x: number, y: number, z: number, w = 1) => {
  x -= m[12]! * w; y -= m[13]! * w; z -= m[14]! * w;
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
 * splat, then the nearer point wins. Cracks with 4+ valid neighbours take
 * their mean, and below 60% coverage of B's geometry in a 9x9 window the
 * warp is not evidence (grazing surfaces arrive as sparse stripes).
 */
export function warpKeyframe(
  a: { view: KeyframeView; image: Uint8Array; depth: Uint8Array },
  b: { view: KeyframeView; render: Uint8Array; depth: Uint8Array },
): KeyframeWarp {
  const { width: wa, height: ha } = a.view, { width: w, height: h } = b.view, n = w * h;
  rgba(a.image, wa, ha, "Keyframe A picture"); rgba(a.depth, wa, ha, "Keyframe A depth");
  rgba(b.render, w, h, "Keyframe B render"); rgba(b.depth, w, h, "Keyframe B depth");
  const Ma = a.view.camera.world_matrix, Pa = a.view.camera.projection_matrix;
  const Mb = b.view.camera.world_matrix, Pb = b.view.camera.projection_matrix;
  const zB = new Float64Array(n), geometry = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (b.depth[t * 4]) { zB[t] = distance(b.view, b.depth[t * 4]!); geometry[t] = 1; }

  const source = new Int32Array(n).fill(-1), sourceZ = new Float64Array(n), inside = new Uint8Array(n);
  let px = 0, py = 0, pz = 0, points = 0;
  for (let v = 0; v < ha; v++) for (let u = 0; u < wa; u++) {
    const q = v * wa + u, byte = a.depth[q * 4]!;
    if (!byte) continue;
    const z = -distance(a.view, byte), [x, y] = unproject(Pa, (u + 0.5) / wa * 2 - 1, 1 - (v + 0.5) / ha * 2, z);
    const [wx, wy, wz] = toWorld(Ma, x, y, z);
    px += wx; py += wy; pz += wz; points++;
    const [bx, by, bz] = toCamera(Mb, wx, wy, wz), d = -bz;
    if (d <= b.view.camera.near) continue;
    const [nx, ny] = project(Pb, bx, by, bz), ix = Math.floor((nx + 1) / 2 * w), iy = Math.floor((1 - ny) / 2 * h);
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

  // Sky is at infinity, so it moves with the camera's rotation only. A painted
  // silhouette can stand a few pixels off A's geometry, so A's sky is only
  // trusted 1% of the frame away from it; nearer pixels become holes.
  const hole = new Uint8Array(n), sky = new Uint8Array(n);
  const perspective = a.view.camera.projection === "perspective" && b.view.camera.projection === "perspective";
  const nearA = boxSum(a.depth.filter((_, i) => i % 4 === 0).map(v => (v ? 1 : 0)), wa, ha, Math.ceil(0.01 * Math.max(wa, ha)));
  let holes = 0, surfacePixels = 0;
  for (let t = 0; t < n; t++) {
    if (geometry[t]) { surfacePixels++; if (valid[t]) continue; }
    else if (perspective) {
      const x = t % w, y = (t - x) / w, [rx, ry] = unproject(Pb, (x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, -1);
      const [dx, dy, dz] = toWorld(Mb, rx, ry, -1, 0), [ax, ay, az] = toCamera(Ma, dx, dy, dz, 0);
      if (az < 0) {
        const [nx, ny] = project(Pa, ax, ay, az), u = Math.floor((nx + 1) / 2 * wa), v = Math.floor((1 - ny) / 2 * ha);
        if (u >= 0 && v >= 0 && u < wa && v < ha && !nearA[v * wa + u]) {
          out.set(a.image.subarray((v * wa + u) * 4, (v * wa + u) * 4 + 4), t * 4); sky[t] = 1; continue;
        }
      }
    }
    hole[t] = 1; if (geometry[t]) holes++;
    out.set(b.render.subarray(t * 4, t * 4 + 4), t * 4);
  }

  const cx = px / points, cy = py / points, cz = pz / points;
  const ea = [Ma[12]! - cx, Ma[13]! - cy, Ma[14]! - cz], eb = [Mb[12]! - cx, Mb[13]! - cy, Mb[14]! - cz];
  const cos = (ea[0]! * eb[0]! + ea[1]! * eb[1]! + ea[2]! * eb[2]!) / (Math.hypot(...ea) * Math.hypot(...eb));
  return { rgba: out, hole, sky, holeShare: surfacePixels ? holes / surfacePixels : 0, angleDeg: Math.acos(Math.min(1, Math.max(-1, cos))) * 180 / Math.PI };
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
 * null painted delta means nothing in the input came from the render.
 */
export function pickCandidate(truth: Uint8Array, candidates: Uint8Array[], painted: (number | null)[],
  width: number, height: number, gate: KeyframeGate = KEYFRAME_GATE) {
  if (!candidates.length || painted.length !== candidates.length) throw new Error("Each candidate needs a mask and a painted delta");
  let index = 0, best = -Infinity;
  const metrics: CandidateMetrics[] = candidates.map((mask, i) => {
    const match = compareMasks(truth, mask, width, height), delta = painted[i] ?? null;
    const isPainted = delta === null || delta >= gate.minPainted;
    const passed = !!match && isPainted && Math.abs(match.centreDx) <= gate.centre && Math.abs(match.centreDy) <= gate.centre
      && match.areaRatio >= gate.area[0] && match.areaRatio <= gate.area[1];
    const score = (passed ? 10 : 0) + (isPainted ? 5 : 0) + (match?.iou ?? -1);
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

/** Copy the warped sky back over the output, 2 px in from the sky's edge so no outline bleeds. */
export function pinSky(output: Uint8Array, warpedSky: Uint8Array, skyMask: Uint8Array, width: number, height: number): Uint8Array {
  rgba(output, width, height, "Keyframe output"); rgba(warpedSky, width, height, "Warped sky");
  const ground = boxSum(skyMask.map(v => (v ? 0 : 1)), width, height, 2), out = output.slice();
  for (let t = 0; t < skyMask.length; t++) if (skyMask[t] && !ground[t]) out.set(warpedSky.subarray(t * 4, t * 4 + 4), t * 4);
  return out;
}
