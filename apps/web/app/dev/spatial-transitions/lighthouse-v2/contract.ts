import * as THREE from "three";
import scene from "./scene.json";

export const WORLD = scene;
export type Mode = "color" | "clay" | "depth";
export type CameraView = "walk" | "inspection";
export type Vec3 = [number, number, number];
export const STORAGE_KEY = `openflipbook:study:${WORLD.id}`;
export type Snapshot = { version: number; time: number; mode: Mode; view: CameraView };
export const INITIAL: Snapshot = { version: WORLD.version, time: 0, mode: "color", view: "walk" };

export function readSnapshot(raw: string | null): Snapshot {
  try {
    const s = JSON.parse(raw ?? "null");
    if (s?.version !== WORLD.version || !Number.isFinite(s.time) || s.time < 0 || s.time > WORLD.duration ||
        !["color", "clay", "depth"].includes(s.mode) || !["walk", "inspection"].includes(s.view)) return { ...INITIAL };
    return { version: WORLD.version, time: s.time, mode: s.mode, view: s.view };
  } catch { return { ...INITIAL }; }
}

export function poseAt(time: number) {
  const t = Math.min(WORLD.duration, Math.max(0, Number.isFinite(time) ? time : 0));
  if (t === WORLD.duration) return poseAt(0);
  const i = WORLD.route.findIndex((p, i) => i < WORLD.route.length - 1 && t < WORLD.route[i + 1]!.time);
  const a = WORLD.route[Math.max(0, i)]!, b = WORLD.route[Math.max(0, i) + 1]!;
  const u = (t - a.time) / (b.time - a.time), p = u * u * (3 - 2 * u);
  const interpolate = (x: number[], y: number[]) => x.map((v, i) => v + (y[i]! - v) * p) as Vec3;
  return { position: interpolate(a.position, b.position), target: interpolate(a.target, b.target) };
}

export function applyCamera(camera: THREE.PerspectiveCamera, time: number, view: CameraView) {
  const pose = view === "inspection" ? WORLD.inspection : poseAt(time);
  camera.position.fromArray(pose.position);
  camera.lookAt(new THREE.Vector3().fromArray(pose.target));
  camera.updateMatrixWorld(true);
}

// Conservative solid envelopes, not an inferred interior or a general navigation mesh.
const solids = [
  new THREE.Box3(new THREE.Vector3(-2.7, 0, -2.7), new THREE.Vector3(2.7, 15, 2.7)),
  new THREE.Box3(new THREE.Vector3(WORLD.annex.start, 0, -1.6), new THREE.Vector3(WORLD.annex.end, 4.5, 1.6)),
];
export function canTraverse(a: Vec3, b: Vec3) {
  if (![...a, ...b].every(Number.isFinite) || a[1] !== WORLD.camera.eyeHeight || b[1] !== WORLD.camera.eyeHeight) return false;
  if ([a, b].some(p => Math.abs(p[0]) > 35 || Math.abs(p[2]) > 35)) return false;
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start), distance = delta.length();
  const ray = new THREE.Ray(start, delta.normalize());
  return solids.every(solid => {
    const padded = solid.clone().expandByScalar(.3);
    if (padded.containsPoint(start) || padded.containsPoint(end)) return false;
    const hit = distance ? ray.intersectBox(padded, new THREE.Vector3()) : null;
    return !hit || start.distanceTo(hit) > distance;
  });
}
