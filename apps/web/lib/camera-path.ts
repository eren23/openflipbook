import { Spherical, Vector3, MathUtils } from "three";
import { CreatorError } from "./creator-error";

export interface OrbitPose { azimuth: number; elevation: number; distance: number }
export interface CameraKeyframe extends OrbitPose { time: number }
export interface CameraPathDraft { version: 1; duration: number; time: number; keyframes: CameraKeyframe[]; pivot: [number, number, number]; target_id: string | null }
export interface CameraPathState { duration: number; time: number; keyframes: CameraKeyframe[] }
export interface CameraPathIssue { kind: "collision" | "occluded"; time: number; end_time: number }
export interface CameraPathCheck {
  status: "clear" | "blocked";
  samples: number; clearance: number; visibility: "sampled" | "not_requested";
  issues: CameraPathIssue[];
}
export interface CameraRig {
  minElevation: number; maxElevation: number; minDistance: number; maxDistance: number;
  read(): OrbitPose;
  write(pose: OrbitPose): void;
  targetSelection(): string;
  targetLabel(): string;
  setActive(active: boolean): void;
  check(frames: readonly CameraKeyframe[]): Promise<CameraPathCheck>;
  draft?(state: CameraPathState | null): void;
  subscribe(listener: (event: "start" | "end" | "reset") => void): () => void;
}

// World coordinates: Y up, azimuth 0 toward +Z, positive toward +X.
// These are scene metres/degrees, not a provider's normalized camera values.
export function orbitPosition(pivot: Vector3, pose: OrbitPose): Vector3 {
  return new Vector3().setFromSpherical(new Spherical(pose.distance,
    MathUtils.degToRad(90 - pose.elevation), MathUtils.degToRad(pose.azimuth))).add(pivot);
}
export function orbitPose(position: Vector3, pivot: Vector3): OrbitPose {
  const spherical = new Spherical().setFromVector3(position.clone().sub(pivot));
  return { azimuth: MathUtils.radToDeg(spherical.theta), elevation: 90 - MathUtils.radToDeg(spherical.phi), distance: spherical.radius };
}
export function sampleCameraPath(frames: readonly CameraKeyframe[], time: number): OrbitPose {
  if (!frames.length) throw new Error("A camera path needs a keyframe");
  if (!Number.isFinite(time)) throw new Error("Invalid camera time");
  const end = frames.findIndex(frame => frame.time >= time);
  if (end <= 0) return { ...frames[end === 0 ? 0 : frames.length - 1]! };
  const a = frames[end - 1]!, b = frames[end]!;
  const t = (time - a.time) / (b.time - a.time);
  // Preserve authored signed turns; shortest-angle interpolation loses full orbits.
  return { azimuth: MathUtils.lerp(a.azimuth, b.azimuth, t), elevation: MathUtils.lerp(a.elevation, b.elevation, t), distance: MathUtils.lerp(a.distance, b.distance, t) };
}

// Keyframe checkpoints for path videos: each leg between two checkpoints stays
// within these limits, so one keyframe can be warped into the next. The 30
// degrees comes from research 34; the 1.5 distance ratio is unmeasured.
export const CHECKPOINT_MAX_DEGREES = 30;
export const CHECKPOINT_MAX_DISTANCE_RATIO = 1.5;
export const MAX_CHECKPOINTS = 12;
export function checkpointTimes(frames: readonly CameraKeyframe[]): number[] {
  const authored = new Set([0, 1, ...frames.map(frame => frame.time)]);
  const samples = [...new Set([...Array.from({ length: 241 }, (_, i) => i / 240), ...authored])].sort((a, b) => a - b);
  const direction = (pose: OrbitPose) => orbitPosition(new Vector3(), { ...pose, distance: 1 });
  const far = (a: OrbitPose, b: OrbitPose) => MathUtils.radToDeg(direction(a).angleTo(direction(b))) > CHECKPOINT_MAX_DEGREES + 1e-6
    || Math.max(a.distance / b.distance, b.distance / a.distance) > CHECKPOINT_MAX_DISTANCE_RATIO + 1e-9;
  const times = [0];
  let last = sampleCameraPath(frames, 0), previous = 0;
  for (const time of samples.slice(1)) {
    // Close the leg at the last sample that was still within the limits.
    if (previous !== times.at(-1) && far(last, sampleCameraPath(frames, time))) { times.push(previous); last = sampleCameraPath(frames, previous); }
    if (authored.has(time)) { times.push(time); last = sampleCameraPath(frames, time); }
    previous = time;
  }
  if (times.length > MAX_CHECKPOINTS) throw new CreatorError(`This path needs more than ${MAX_CHECKPOINTS} keyframe checkpoints; shorten the turn or the push`, 400);
  return times;
}

export function insertCameraKeyframe(frames: readonly CameraKeyframe[], time: number): CameraKeyframe[] {
  if (frames.length >= 12 || !Number.isFinite(time) || time <= 0 || time >= 1 || frames.some(frame => Math.abs(frame.time - time) < 0.01)) return [...frames];
  return [...frames, { ...sampleCameraPath(frames, time), time }].sort((a, b) => a.time - b.time);
}
