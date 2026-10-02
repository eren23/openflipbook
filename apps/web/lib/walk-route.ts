import { CHECKPOINT_MAX_DEGREES, MAX_CHECKPOINTS } from "./camera-path";
export interface WalkWaypoint { x: number; z: number; yaw: number; hold?: number }
export interface WalkRouteState { index: number; held: number }
export const angleDifference = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// This produces movement requests only. Physics, not the route, owns the camera position.
export function routeMovement(route: readonly WalkWaypoint[], state: WalkRouteState, pos: { x: number; z: number }, yaw: number, dt: number) {
  const target = route[state.index];
  if (!target) return { x: 0, z: 0, yaw, done: true };
  const angle = angleDifference(target.yaw, yaw);
  const nextYaw = yaw + Math.max(-1.5 * dt, Math.min(1.5 * dt, angle));
  if (Math.abs(angle) > 0.025) return { x: 0, z: 0, yaw: nextYaw, done: false };
  const dx = target.x - pos.x, dz = target.z - pos.z, distance = Math.hypot(dx, dz);
  if (distance > 0.035) {
    const amount = Math.min(distance, 2.5 * dt);
    return { x: dx / distance * amount, z: dz / distance * amount, yaw: target.yaw, done: false };
  }
  state.held += dt;
  if (state.held >= (target.hold ?? 0)) { state.index++; state.held = 0; }
  return { x: 0, z: 0, yaw: target.yaw, done: state.index === route.length };
}

// The walk camera's eye on flat ground: the capsule rests at 0.82 m and the
// eye is 0.78 m above it (place-viewport).
export const WALK_EYE_HEIGHT = 1.6;
// A walk video's checkpoint spacing. In 4 m a facade 12 m ahead grows 1.5
// times, the distance ratio the orbit checkpoints allow (camera-path), and the
// leg (about 2.9 s at walking speed) fits in one 5 s H3 clip, which moves for
// about 4.2 s (research 36). Tune it here.
export const WALK_CHECKPOINT_METRES = 4;
export interface WalkCheckpoint { x: number; z: number; yaw: number }
/**
 * Eye-level checkpoint poses along a route, walked the way routeMovement
 * walks it: turn in place to each waypoint's yaw, then go straight to it.
 * A new checkpoint follows each 30 degrees turned or 4 m walked since the
 * last one, and the route's end is the last. Throws under 2 (no leg to
 * make) or past 12 checkpoints.
 */
export function walkCheckpoints(route: readonly WalkWaypoint[]): WalkCheckpoint[] {
  const start = route[0], short = "This walk needs at least 2 checkpoints. Make the route longer.";
  if (!start) throw new Error(short);
  const at = { x: start.x, z: start.z, yaw: start.yaw }, out = [{ ...at }], limit = CHECKPOINT_MAX_DEGREES * Math.PI / 180, e = 1e-9;
  let moved = 0, turned = 0;
  const push = () => { out.push({ ...at }); moved = 0; turned = 0; };
  for (const target of route.slice(1)) {
    for (let turn = angleDifference(target.yaw, at.yaw); Math.abs(turn) > e;) {
      const step = Math.sign(turn) * Math.min(Math.abs(turn), limit - turned);
      at.yaw = angleDifference(at.yaw + step, 0); turned += Math.abs(step); turn -= step;
      if (turned >= limit - e) push();
    }
    const from = { x: at.x, z: at.z }, length = Math.hypot(target.x - from.x, target.z - from.z);
    for (let done = 0; length - done > e;) {
      const step = Math.min(length - done, WALK_CHECKPOINT_METRES - moved);
      done += step; moved += step;
      at.x = from.x + (target.x - from.x) * done / length; at.z = from.z + (target.z - from.z) * done / length;
      if (moved >= WALK_CHECKPOINT_METRES - e) push();
    }
  }
  if (moved > e || turned > e) push();
  if (out.length < 2) throw new Error(short);
  if (out.length > MAX_CHECKPOINTS) throw new Error(`This walk needs ${out.length} checkpoints, more than ${MAX_CHECKPOINTS}. Shorten the route.`);
  return out;
}
