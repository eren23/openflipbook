/**
 * Copy-first walk still (research 41-43): move the approved prior one small step forward using only its
 * own pixels and a relative depth map. Port of the research warp.py ("copy-first-warp-v1"): fixed 60° FOV,
 * forward step tz in median-depth units, then an image-plane turn; a gap revealed behind a near object takes
 * the prior's pixels at the farthest depth within 15 px. Any pixel still uncovered refuses the step.
 * ponytail: monocular relative depth and an image-plane turn, never a calibrated camera or ground yaw;
 * add a model strip fill for uncovered pixels if sharp turns matter.
 */
export const COPY_FIRST_WARP_VERSION = "copy-first-warp-v1";
export interface CopyFirstStep { tz: number; yaw_degrees: number; pitch_degrees: number; offset: number; fov_degrees: number }

/** Depth PNG gray (near = bright) -> depth z, divided by its median: 2-98 percentile stretch, z = 1 / (offset + d). */
export function copyFirstDepth(gray: Uint8Array, offset: number): Float64Array {
  const n = gray.length, hist = new Float64Array(256); for (const g of gray) hist[g]!++;
  const nth = (k: number) => { let c = 0; for (let i = 0; i < 256; i++) { c += hist[i]!; if (k < c) return i; } return 255; };
  const pct = (p: number) => { const x = (n - 1) * p / 100, a = nth(Math.floor(x)); return (a + (nth(Math.ceil(x)) - a) * (x - Math.floor(x))) / 255; };
  const lo = pct(2), hi = pct(98), z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = 1 / (offset + Math.min(1, Math.max(0, (gray[i]! / 255 - lo) / (hi - lo + 1e-6))));
  const s = Float64Array.from(z).sort(), median = n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  for (let i = 0; i < n; i++) z[i]! /= median;
  return z;
}

function rotation(yaw: number, pitch: number) { // +yaw = turn right, +pitch = tilt up; R = Rx(pitch) Ry(yaw)
  const [cy, sy, cx, sx] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  return [cy, 0, -sy, sx * sy, cx, sx * cy, cx * sy, -sx, cx * cy];
}

/** Separable max filter of radius r over in-frame values. */
function maxFilter(a: Float64Array, w: number, h: number, r: number) {
  const t = new Float64Array(a.length), out = new Float64Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = -Infinity; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, a[y * w + k]!); t[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = -Infinity; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, t[k * w + x]!); out[y * w + x] = m; }
  return out;
}

/** rgb: 3 bytes per pixel. Returns the warped picture and the count of pixels no prior pixel covers. */
export function copyFirstWarp(rgb: Uint8Array, z: Float64Array, w: number, h: number, step: CopyFirstStep): { rgb: Uint8Array; holes: number } {
  const n = w * h, f = 0.5 * w / Math.tan(step.fov_degrees * Math.PI / 360), cx = w / 2, cy = h / 2, tz = step.tz;
  if (rgb.length !== n * 3 || z.length !== n) throw new Error("Copy-first picture and depth sizes differ");
  const R = rotation(step.yaw_degrees * Math.PI / 180, step.pitch_degrees * Math.PI / 180);
  let zt = new Float64Array(n).fill(Infinity);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) { // forward splat, nearest surface wins
    const d = z[v * w + u]!, X = (u - cx) / f * d, Y = (v - cy) / f * d, Z = d - tz;
    const xn = R[0]! * X + R[1]! * Y + R[2]! * Z, yn = R[3]! * X + R[4]! * Y + R[5]! * Z, zn = R[6]! * X + R[7]! * Y + R[8]! * Z;
    if (!(zn > 0.05)) continue;
    const un = Math.round(f * xn / zn + cx), vn = Math.round(f * yn / zn + cy);
    if (un >= 0 && un < w && vn >= 0 && vn < h && zn < zt[vn * w + un]!) zt[vn * w + un] = zn;
  }
  for (let pass = 0; pass < 4; pass++) { // close splat cracks from magnification; large gaps stay gaps
    const prev = zt; zt = Float64Array.from(prev);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Number.isFinite(prev[y * w + x])) continue; let m = Infinity;
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) if (Number.isFinite(prev[j * w + i])) m = Math.min(m, prev[j * w + i]!);
      if (m < 1e8) zt[y * w + x] = m;
    }
  }
  const hole = new Uint8Array(n); for (let i = 0; i < n; i++) hole[i] = !Number.isFinite(zt[i]) || zt[i]! > 1e8 ? 1 : 0;
  const far = maxFilter(zt.map((v, i) => hole[i] ? 0 : v), w, h, 15); // revealed background: the farthest depth within 15 px
  for (let i = 0; i < n; i++) { if (hole[i] && far[i]! > 0) { zt[i] = far[i]!; hole[i] = 0; } if (hole[i]) zt[i] = 1; }
  const out = new Uint8Array(n * 3); let holes = 0;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) { // back to the prior camera, bilinear sample of its pixels
    const t = v * w + u, d = zt[t]!, X = (u - cx) / f * d, Y = (v - cy) / f * d;
    const xs = R[0]! * X + R[3]! * Y + R[6]! * d, ys = R[1]! * X + R[4]! * Y + R[7]! * d, zs = R[2]! * X + R[5]! * Y + R[8]! * d + tz;
    const mx = f * xs / zs + cx, my = f * ys / zs + cy;
    if (hole[t] || !(mx >= 0 && mx <= w - 1 && my >= 0 && my <= h - 1)) { holes++; continue; }
    const x0 = Math.floor(mx), y0 = Math.floor(my), ax = mx - x0, ay = my - y0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    for (let c = 0; c < 3; c++) out[t * 3 + c] = Math.round((rgb[(y0 * w + x0) * 3 + c]! * (1 - ax) + rgb[(y0 * w + x1) * 3 + c]! * ax) * (1 - ay) + (rgb[(y1 * w + x0) * 3 + c]! * (1 - ax) + rgb[(y1 * w + x1) * 3 + c]! * ax) * ay);
  }
  return { rgb: out, holes };
}

export const IMAGE_LED_DEPTH_MODEL = "fal-ai/image-preprocessors/depth-anything/v2";
export interface CopyFirstParameters { tz: number; max_turn_degrees: number; pitch_degrees: 0; offset: 0.4; fov_degrees: 60; bg_fill: true; warp_version: typeof COPY_FIRST_WARP_VERSION }
/** The backend's closed copy-first profile; anything else means a changed or unknown warp. */
export function copyFirstParameters(value: unknown): CopyFirstParameters {
  const v = value as Record<string, unknown>, keys = ["tz", "max_turn_degrees", "pitch_degrees", "offset", "fov_degrees", "bg_fill", "warp_version"];
  if (!v || typeof v !== "object" || Object.keys(v).length !== keys.length || keys.some(k => !(k in v)) || typeof v.tz !== "number" || !(v.tz > 0 && v.tz <= 0.3) || typeof v.max_turn_degrees !== "number" || !(v.max_turn_degrees >= 0 && v.max_turn_degrees <= 10)
    || v.pitch_degrees !== 0 || v.offset !== 0.4 || v.fov_degrees !== 60 || v.bg_fill !== true || v.warp_version !== COPY_FIRST_WARP_VERSION) throw new Error("Unknown copy-first profile");
  return v as unknown as CopyFirstParameters;
}
