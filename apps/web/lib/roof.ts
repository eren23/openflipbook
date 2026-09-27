/**
 * A roof on top of a footprint, so the proxy stops being a shoebox.
 *
 * Conditioning a render on the block world's depth buys geometry and spends
 * the art: measured, it more than doubles silhouette fidelity and returns a
 * street of flat-topped boxes (research 35). The boxes are the problem, not
 * the conditioning -- so give each one a roof.
 *
 * Footprints here are axis-aligned rectangles, which is the whole reason this
 * is fifty lines instead of a library: the general method (decompose the
 * polygon by straight skeleton, fit a parametric roof per part) collapses to
 * closed form on a rectangle. Every shape below is a small set of half-spaces,
 * so the renderer clips a ray against them exactly the way it already clips
 * against the walls.
 *
 * ponytail: two shapes, chosen by aspect. Hip and half-hip are the other two
 * the literature fits, and they need a roof-type label per building rather
 * than a rule -- that is a five-way choice a decision site can ask for once
 * there is something to ask about.
 */

export type RoofKind = "flat" | "gable" | "pyramid";

/** Roof height as a share of the SHORTER footprint side: a pitch, not a
 *  fixed metre value, so a cottage and a hall both look like themselves. */
const PITCH = 0.45;
/** Past this, a roof reads as a spire and starts hiding the building. */
const MAX_RISE_FRACTION = 0.6;
/** Squarer than this and a ridge has nothing to run along. */
const GABLE_ASPECT = 1.25;

export interface RoofShape {
  kind: RoofKind;
  /** Height above the wall top, in world units. Zero for a flat roof. */
  rise: number;
  /** True when the ridge runs along the footprint's local x axis. */
  ridgeAlongX: boolean;
}

/** The roof a footprint gets when nothing has said otherwise. */
export function roofFor(w: number, d: number, height: number): RoofShape {
  if (!(w > 0) || !(d > 0) || !(height > 0)) return { kind: "flat", rise: 0, ridgeAlongX: true };
  const shortSide = Math.min(w, d);
  const rise = Math.min(shortSide * PITCH, height * MAX_RISE_FRACTION);
  if (rise <= 0) return { kind: "flat", rise: 0, ridgeAlongX: true };
  const aspect = Math.max(w, d) / shortSide;
  // A long building gets a ridge down its length; a squat one gets a point.
  return aspect >= GABLE_ASPECT
    ? { kind: "gable", rise, ridgeAlongX: w >= d }
    : { kind: "pyramid", rise, ridgeAlongX: true };
}

/**
 * Where a ray enters the roof volume, or Infinity if it misses.
 *
 * Local space: the ray starts at (lx, ly, oz) and runs along (ldx, ldy, dz),
 * with the footprint centred on the origin. The volume sits between the wall
 * top `z1` and the ridge at `z1 + rise`, and is convex, so the usual
 * latest-entry / earliest-exit clip decides it. Allocation-free on purpose:
 * this runs once per block per pixel.
 */
export function roofEntry(
  kind: RoofKind, rise: number, ridgeAlongX: boolean,
  hw: number, hd: number, z1: number,
  lx: number, ly: number, oz: number,
  ldx: number, ldy: number, dz: number,
  tFloor: number, tCap: number,
): number {
  if (kind === "flat" || rise <= 0) return Infinity;
  let tMin = tFloor;
  let tMax = tCap;

  // One half-space: A*x + B*y + C*z <= D, clipped against the ray.
  const clip = (a: number, b: number, c: number, dRhs: number): boolean => {
    const denom = a * ldx + b * ldy + c * dz;
    const slack = dRhs - (a * lx + b * ly + c * oz);
    if (Math.abs(denom) < 1e-12) return slack >= 0; // parallel: inside or never
    const t = slack / denom;
    if (denom > 0) {
      if (t < tMax) tMax = t;
    } else if (t > tMin) {
      tMin = t;
    }
    return tMin <= tMax;
  };

  if (!clip(0, 0, -1, -z1)) return Infinity; // the roof starts at the wall top
  const apex = z1 + rise;
  if (kind === "pyramid") {
    if (!clip(rise / hw, 0, 1, apex)) return Infinity;
    if (!clip(-rise / hw, 0, 1, apex)) return Infinity;
    if (!clip(0, rise / hd, 1, apex)) return Infinity;
    if (!clip(0, -rise / hd, 1, apex)) return Infinity;
  } else if (ridgeAlongX) {
    // Ridge runs along x: the slope falls across y, and the gable ends are walls.
    if (!clip(0, rise / hd, 1, apex)) return Infinity;
    if (!clip(0, -rise / hd, 1, apex)) return Infinity;
    if (!clip(1, 0, 0, hw)) return Infinity;
    if (!clip(-1, 0, 0, hw)) return Infinity;
  } else {
    if (!clip(rise / hw, 0, 1, apex)) return Infinity;
    if (!clip(-rise / hw, 0, 1, apex)) return Infinity;
    if (!clip(0, 1, 0, hd)) return Infinity;
    if (!clip(0, -1, 0, hd)) return Infinity;
  }
  return tMin <= tMax ? tMin : Infinity;
}
