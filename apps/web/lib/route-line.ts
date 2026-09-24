import type { MapCrop, ObserverPose, WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

import { carveLanes } from "./lane-carve";
import { blockDistance, pointInBlock, renderLayoutControl, solidBlocks, type LayoutBlock } from "./layout-control";

// A route the user DRAWS on the map: the stroke becomes world positions, the
// camera looks along it, and checkpoints mark where a new keyframe image is
// needed (research 33: a warp holds to about 30 degrees of turn).

export const EYE_HEIGHT = 1.7;
export const DEFAULT_FOV = Math.PI / 2;

/** How wide a lane the ROUTE needs, as opposed to a person.
 *
 *  `LANE_GAP` is a pedestrian gap -- room to squeeze between two walls. A
 *  camera also needs standoff, or it is pressed against a seven-metre face and
 *  sees only stone. Walking a live town at the pedestrian gap left every
 *  camera a median 4 units from the line the user drew and the worst 8.5; at
 *  this gap the median is 1.0 and the worst 4.5, so the walk follows the
 *  stroke instead of scattering to whatever spots happened to be open. */
export const ROUTE_LANE_GAP = 8;

export interface RouteOptions {
  /** A turn this large since the last checkpoint forces a new one. */
  maxTurnDeg?: number;
  /** ...so does this much travel (world units). */
  maxStepUnits?: number;
  /** Look at this place instead of along the route (a tapped building). */
  lookAt?: WorldVec2 | null;
  /** The frame the drawn places live in (null = the root map). */
  frameParentId?: string | null;
  /** Daylight to open between overlapping footprints before routing, in world
   *  units; 0 walks the town exactly as it was extracted. */
  laneGap?: number;
  eyeHeight?: number;
  fov?: number;
}

export interface RouteCheckpoint {
  observer: ObserverPose;
  /** Distance from the start of the route, world units. */
  distance: number;
  reason: "start" | "turn" | "distance" | "end";
  /** The camera had to step aside to clear a building. */
  moved: boolean;
  /** No spot within reach is outside every building: the line was drawn
   *  through a place the camera cannot stand. */
  blocked: boolean;
}

export interface Route {
  /** The walked line after clearance, for drawing back onto the map. */
  path: WorldVec2[];
  checkpoints: RouteCheckpoint[];
  length: number;
}

/** Image-normalized stroke points (0..1) to world positions in `frame`. */
export function strokeToWorld(points: readonly { x: number; y: number }[], frame: MapCrop): WorldVec2[] {
  return points.map((p) => ({ x: frame.x + p.x * frame.w, y: frame.y + p.y * frame.h }));
}

const dist = (a: WorldVec2, b: WorldVec2) => Math.hypot(b.x - a.x, b.y - a.y);

/** Resample a hand-drawn stroke to even steps; drops jitter and duplicate points. */
export function resample(points: readonly WorldVec2[], step: number): WorldVec2[] {
  const clean: WorldVec2[] = [];
  for (const p of points) if (!clean.length || dist(clean[clean.length - 1]!, p) > 1e-9) clean.push({ x: p.x, y: p.y });
  if (clean.length < 2) return clean;
  const out: WorldVec2[] = [clean[0]!];
  let carry = 0; // distance walked since the last emitted point
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1]!, b = clean[i]!;
    const seg = dist(a, b);
    let walked = 0;
    while (carry + (seg - walked) >= step) {
      walked += step - carry;
      out.push({ x: a.x + ((b.x - a.x) * walked) / seg, y: a.y + ((b.y - a.y) * walked) / seg });
      carry = 0;
    }
    carry += seg - walked;
  }
  const last = clean[clean.length - 1]!;
  if (dist(out[out.length - 1]!, last) > 1e-9) out.push(last);
  return out;
}

// A camera standing against a wall renders a wall. Keep it back by roughly
// this fraction of the building's height, within these bounds (world units).
const STANDOFF_FRACTION = 0.45;
const STANDOFF_MIN = 1.5;
const STANDOFF_MAX = 5;
// How far a camera may be nudged sideways off the drawn line, and how the
// nudge is traded off: clearance first, then a smooth line, then staying put.
const MAX_OFFSET = 14;
const OFFSET_STEP = 0.5;
const WEIGHT_SHORT = 3; // per unit short of the standoff
const WEIGHT_INSIDE = 20; // per unit actually inside a building
// Squared, so the walk ramps sideways over several steps instead of dog-legging.
const WEIGHT_BEND = 0.25;
const WEIGHT_AWAY = 0.1;
// The route is recomputed while the pointer moves, so the work per stroke has
// to be bounded: samples x offsets squared, with 57 offsets.
const MAX_SAMPLES = 240;

const standoff = (b: LayoutBlock) => Math.min(STANDOFF_MAX, Math.max(STANDOFF_MIN, b.height * STANDOFF_FRACTION));

/** What one camera position costs: being too close to a building. Standing IN
 *  one is not a position at all (Infinity), so the walk goes around. */
function placementCost(pos: WorldVec2, walls: readonly LayoutBlock[]): number {
  let cost = 0;
  for (const b of walls) {
    const d = blockDistance(b, pos);
    if (d <= 0) return Infinity;
    cost += WEIGHT_SHORT * Math.max(0, standoff(b) - d);
  }
  return cost;
}

/** How deep inside buildings a spot is, for the "nowhere to stand" fallback. */
function penetration(pos: WorldVec2, walls: readonly LayoutBlock[]): number {
  let deepest = 0;
  for (const b of walls) deepest = Math.max(deepest, -blockDistance(b, pos));
  return deepest;
}

/**
 * Nudge the walk sideways off the drawn line so cameras have room, as ONE
 * smooth line: a per-sample "first clear side" search alternates north and
 * south and turns a walk into a zig-zag (seen live, 2026-09-17). A small
 * dynamic program over sideways offsets trades clearance against bending and
 * against leaving the line the user drew.
 */
function clearPath(points: readonly WorldVec2[], headings: readonly number[], walls: readonly LayoutBlock[]): { path: WorldVec2[]; moved: boolean[]; blocked: boolean[] } {
  if (!walls.length) return { path: points.map((p) => ({ ...p })), moved: points.map(() => false), blocked: points.map(() => false) };
  const offsets: number[] = [];
  for (let o = -MAX_OFFSET; o <= MAX_OFFSET; o += OFFSET_STEP) offsets.push(o);
  const at = (i: number, offset: number): WorldVec2 => ({
    x: points[i]!.x - Math.sin(headings[i]!) * offset,
    y: points[i]!.y + Math.cos(headings[i]!) * offset,
  });
  const blocked: boolean[] = [];
  const cost = points.map((_, i) => {
    const row = offsets.map((o) => placementCost(at(i, o), walls) + WEIGHT_AWAY * Math.abs(o));
    // Drawn through a building with no way round: keep the least bad spot and
    // say so, instead of pretending a camera can stand in a wall.
    const stuck = row.every((c) => !Number.isFinite(c));
    blocked.push(stuck);
    return stuck ? offsets.map((o) => WEIGHT_INSIDE * penetration(at(i, o), walls) + WEIGHT_AWAY * Math.abs(o)) : row;
  });
  const best = cost[0]!.slice();
  const from: number[][] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = best.slice();
    const choice: number[] = [];
    for (let k = 0; k < offsets.length; k++) {
      let bestPrevious = 0;
      let bestTotal = Infinity;
      for (let j = 0; j < offsets.length; j++) {
        const bend = offsets[k]! - offsets[j]!;
        const total = previous[j]! + WEIGHT_BEND * bend * bend;
        if (total < bestTotal) { bestTotal = total; bestPrevious = j; }
      }
      best[k] = bestTotal + cost[i]![k]!;
      choice[k] = bestPrevious;
    }
    from.push(choice);
  }
  let k = best.indexOf(Math.min(...best));
  const chosen: number[] = new Array(points.length);
  for (let i = points.length - 1; i >= 0; i--) {
    chosen[i] = k;
    if (i > 0) k = from[i - 1]![k]!;
  }
  return {
    path: chosen.map((index, i) => at(i, offsets[index]!)),
    moved: chosen.map((index) => Math.abs(offsets[index]!) > 0.05),
    blocked,
  };
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Turn a drawn stroke into the cameras a route video needs. Cameras look along
 * the stroke (or at `lookAt`), stand clear of buildings, and a checkpoint lands
 * at the start, at the end, whenever the view has turned `maxTurnDeg`, and at
 * least every `maxStepUnits`.
 */
export function routeFromStroke(
  world: readonly WorldVec2[],
  entities: readonly WorldEntityGeo[] = [],
  options: RouteOptions = {},
): Route {
  const maxTurn = ((options.maxTurnDeg ?? 30) * Math.PI) / 180;
  const maxStep = options.maxStepUnits ?? 18;
  const eye = options.eyeHeight ?? EYE_HEIGHT;
  const fov = options.fov ?? DEFAULT_FOV;
  // Extracted footprints overlap: on the live map every point inside the town
  // is inside a building, so a route could only ever hug the outside. Narrow
  // them about their centres first, and the town has lanes to walk.
  // A quarter or district -- the container an ascend synthesizes -- is a frame
  // OTHER places are nested inside, and it spans everything they span. Left
  // solid it makes the whole map one building: a live route stepped all 53 of
  // its cameras aside and looped outside the town it was drawn in. Both halves
  // are needed: only a frame qualifies, so a hall drawn straight through still
  // reports blocked, and only when the whole line is inside it, so a frame the
  // route merely passes still has walls.
  const frames = new Set(entities.map((e) => e.parent_id).filter((id): id is string => !!id));
  const container = (b: LayoutBlock) => frames.has(b.id) && world.every((p) => pointInBlock(b, p));
  const walls = carveLanes(
    solidBlocks(entities, options.frameParentId ?? null).filter((b) => !container(b)),
    options.laneGap ?? ROUTE_LANE_GAP,
  );
  // Sample fine enough to see corners, whatever the distance limit is — but
  // the sideways walk costs samples x offsets squared, and a stroke across a
  // zoomed-out map is arbitrarily long in world units, so cap the count.
  let raw = 0;
  for (let i = 1; i < world.length; i++) raw += dist(world[i - 1]!, world[i]!);
  const sampleStep = Math.max(0.25, raw / MAX_SAMPLES, Math.min(maxStep / 12, raw / 48));
  const points = resample(world, sampleStep);
  if (points.length < 2) return { path: points.map((p) => p), checkpoints: [], length: 0 };

  const drawnHeadings = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
    return Math.atan2(b.y - a.y, b.x - a.x);
  });
  const { path, moved, blocked } = clearPath(points, drawnHeadings, walls);
  const gazes: number[] = [];
  const lengths: number[] = [];
  let length = 0;
  for (let i = 0; i < path.length; i++) {
    if (i) length += dist(path[i - 1]!, path[i]!);
    lengths.push(length);
    // Look along the walked line (which may differ from the drawn one), or at
    // the chosen place. The baseline spans a few metres so a small sideways
    // nudge does not read as a turn.
    const span = Math.max(1, Math.round(2 / sampleStep));
    const a = path[Math.max(0, i - span)]!, b = path[Math.min(path.length - 1, i + span)]!;
    const heading = Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 ? Math.atan2(b.y - a.y, b.x - a.x) : drawnHeadings[i]!;
    gazes.push(options.lookAt ? Math.atan2(options.lookAt.y - path[i]!.y, options.lookAt.x - path[i]!.x) : heading);
  }

  const at = (i: number, reason: RouteCheckpoint["reason"]): RouteCheckpoint => ({
    observer: { pos: path[i]!, eye_height: eye, gaze: gazes[i]!, fov, pitch: 0 },
    distance: lengths[i]!,
    reason,
    moved: moved[i]!,
    blocked: blocked[i]!,
  });
  const checkpoints: RouteCheckpoint[] = [at(0, "start")];
  let last = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const turned = Math.abs(wrapPi(gazes[i]! - gazes[last]!)) >= maxTurn;
    const far = lengths[i]! - lengths[last]! >= maxStep;
    if (turned || far) {
      checkpoints.push(at(i, turned ? "turn" : "distance"));
      last = i;
    }
  }
  const endIndex = path.length - 1;
  // The end is always a checkpoint (the route's known finish pose), unless the
  // last one is already on top of it.
  if (lengths[endIndex]! - lengths[last]! > 1e-6) checkpoints.push(at(endIndex, "end"));
  return { path, checkpoints: merge(splitTurns(checkpoints, maxTurn, options.lookAt ?? null)), length };
}

/** A sharp corner turns more than one segment can hold, so add in-place
 *  rotation checkpoints until no segment turns more than `maxTurn`. */
function splitTurns(checkpoints: RouteCheckpoint[], maxTurn: number, lookAt: WorldVec2 | null): RouteCheckpoint[] {
  const out: RouteCheckpoint[] = [];
  for (let i = 0; i < checkpoints.length; i++) {
    const current = checkpoints[i]!;
    out.push(current);
    const next = checkpoints[i + 1];
    if (!next) continue;
    const turn = wrapPi(next.observer.gaze - current.observer.gaze);
    const extra = Math.ceil(Math.abs(turn) / maxTurn) - 1;
    for (let k = 1; k <= extra; k++) {
      const t = k / (extra + 1);
      // Aiming at a place: step along the walk and keep aiming at it. Free
      // look: turn on the spot, because a cut corner can land inside a wall.
      const pos = lookAt
        ? { x: current.observer.pos.x + (next.observer.pos.x - current.observer.pos.x) * t, y: current.observer.pos.y + (next.observer.pos.y - current.observer.pos.y) * t }
        : current.observer.pos;
      out.push({
        observer: { ...current.observer, pos, gaze: lookAt ? Math.atan2(lookAt.y - pos.y, lookAt.x - pos.x) : current.observer.gaze + turn * t },
        distance: lookAt ? current.distance + (next.distance - current.distance) * t : current.distance,
        reason: "turn",
        moved: current.moved || next.moved,
        blocked: current.blocked || next.blocked,
      });
    }
  }
  return out;
}

/** Two checkpoints a step apart and facing the same way are one image. */
function merge(checkpoints: RouteCheckpoint[]): RouteCheckpoint[] {
  const out: RouteCheckpoint[] = [];
  for (const c of checkpoints) {
    const previous = out[out.length - 1];
    const near = previous
      && dist(previous.observer.pos, c.observer.pos) < 2
      && Math.abs(wrapPi(c.observer.gaze - previous.observer.gaze)) < Math.PI / 18;
    if (near && c.reason !== "end") continue;
    if (near && previous) out.pop();
    out.push(c);
  }
  return out;
}

/** How wide the block render used to judge a shot is. Small on purpose: this
 *  answers "what does this camera see", not "what will it look like". */
const SHOT_W = 160;
const SHOT_H = 96;
/** A camera seeing less built surface than this is looking at nothing -- open
 *  ground, or the inside of a wall. The receipt for the first walk recorded
 *  the gap: "nothing stops it putting a camera against a wall, or facing open
 *  ground where this town has no boxes". */
export const SHOT_MIN_BUILT = 0.04;

export interface RouteShot {
  index: number;
  observer: ObserverPose;
  /** Distance from the start of the route, world units. */
  distance: number;
  reason: RouteCheckpoint["reason"];
  /** The places in frame, largest share first -- what this shot is OF. */
  sees: { label: string; share: number }[];
  /** Share of the frame that is a building rather than sky or ground. */
  built: number;
  /** Worth painting: it sees enough, and it is not standing in a wall. */
  worth: boolean;
}

/** Turn a drawn route into the shots that would be painted along it.
 *
 *  A checkpoint is a camera; a shot is that camera plus what it can see from
 *  there. The block render already knows: it returns the places in frame and
 *  how much of the frame each one covers, so a shot can say what it is OF
 *  before anything is generated. That is also the only way to tell a camera
 *  worth painting from one facing open ground or pressed into a wall. */
export function routeShots(
  route: Route,
  entities: readonly WorldEntityGeo[] = [],
  options: RouteOptions = {},
): RouteShot[] {
  return route.checkpoints.map((c, index) => {
    const control = renderLayoutControl(
      entities,
      c.observer,
      SHOT_W,
      SHOT_H,
      options.frameParentId ?? null,
      options.laneGap ?? ROUTE_LANE_GAP,
      true,
    );
    const total = SHOT_W * SHOT_H;
    const sees = control.visible
      .map((v) => ({ label: v.label, share: v.pixels / total }))
      .filter((v) => v.share > 0.002)
      .sort((a, b) => b.share - a.share);
    const built = sees.reduce((s, v) => s + v.share, 0);
    return {
      index,
      observer: c.observer,
      distance: c.distance,
      reason: c.reason,
      sees,
      built,
      worth: !c.blocked && built >= SHOT_MIN_BUILT,
    };
  });
}

/** The shots a walk actually paints: the worth ones, one per standing spot.
 *  A sharp bend adds turn-on-the-spot checkpoints, and each became its own
 *  paid shot and clip: live, two of five clips were the camera turning where
 *  the route began (2026-09-24). Keep the last of each spot, which faces the
 *  way the walk then goes. */
export function paintedShots(shots: readonly RouteShot[]): RouteShot[] {
  const worth = shots.filter((s) => s.worth);
  return worth.filter((s, i) => {
    const next = worth[i + 1];
    return !next || dist(s.observer.pos, next.observer.pos) > 0.5;
  });
}

/** The canvas transform (ctx.setTransform order: a, b, c, d, e, f) that draws
 *  a map image turned so the camera's gaze points UP, with the camera at the
 *  lower middle and `span` world units across the output. Over a north-up
 *  crop and "you are facing X", the model could not tell where it stood or
 *  which side the river was on, and drew a generic square (2026-09-24). */
export function aheadUpTransform(
  frame: { x: number; y: number; w: number; h: number },
  imageW: number,
  imageH: number,
  observer: { pos: WorldVec2; gaze: number },
  span: number,
  outW: number,
  outH: number,
): [number, number, number, number, number, number] {
  const kx = imageW / frame.w, ky = imageH / frame.h; // source px per world unit
  const s = outW / span; // output px per world unit
  const phi = -Math.PI / 2 - observer.gaze; // gaze direction -> straight up
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const tx = outW / 2, ty = outH * 0.8;
  const ox = frame.x - observer.pos.x, oy = frame.y - observer.pos.y;
  return [
    (s * cos) / kx,
    (s * sin) / kx,
    (-s * sin) / ky,
    (s * cos) / ky,
    tx + s * (cos * ox - sin * oy),
    ty + s * (sin * ox + cos * oy),
  ];
}
