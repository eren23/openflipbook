import fixture from "./scene.json";

export const WORLD = fixture;
export type Vec3 = [number, number, number];
export interface Pose { position: Vec3; yaw: number; pitch: number; label: string }
export type RenderMode = "illustrated" | "clay";
export const BOOKMARKS = [{ time: 0, label: "Quay" }, { time: 5.5, label: "Doorway" },
  { time: 10, label: "Inside" }, { time: 12.5, label: "Looking back" }, { time: 20, label: "Return" }];

export function poseAt(time: number): Pose {
  const t = Math.min(WORLD.duration, Math.max(0, Number.isFinite(time) ? time : 0));
  const keys = WORLD.keyframes;
  // Exact start pose at the loop boundary, not a merely equivalent 2pi angle.
  if (t === WORLD.duration) return poseAt(0);
  const index = keys.findIndex((key, i) => i < keys.length - 1 && t < keys[i + 1]!.time);
  const a = keys[Math.max(0, index)]!, b = keys[Math.max(0, index) + 1]!;
  const p = (t - a.time) / (b.time - a.time);
  const angle = p * p * (3 - 2 * p);
  return { position: a.position.map((v, i) => v + (b.position[i]! - v) * p) as Vec3,
    yaw: a.yaw + (b.yaw - a.yaw) * angle, pitch: a.pitch + (b.pitch - a.pitch) * angle, label: a.label };
}

export function direction(pose: Pose): Vec3 {
  return [Math.sin(pose.yaw) * Math.cos(pose.pitch), Math.sin(pose.pitch), Math.cos(pose.yaw) * Math.cos(pose.pitch)];
}

export function proposedStep(pose: Pose, forward: number, sideways: number): Pose {
  return { ...pose, label: "Explore", position: [pose.position[0] + Math.sin(pose.yaw) * forward - Math.cos(pose.yaw) * sideways,
    pose.position[1], pose.position[2] + Math.cos(pose.yaw) * forward + Math.sin(pose.yaw) * sideways] };
}
