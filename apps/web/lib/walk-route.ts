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
