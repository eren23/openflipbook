import { type Vector3, MathUtils } from "three";
import { orbitPosition, sampleCameraPath, type CameraKeyframe, type CameraPathCheck, type CameraPathIssue } from "./camera-path";
import { loadPlacePhysics, type Solid } from "./place-physics";
import { placeCollider } from "./place-colliders";

const MAX_SEGMENTS = 4096, MAX_ERROR = 0.01, VISIBILITY_STEP = 0.25;
const rotation = { x: 0, y: 0, z: 0, w: 1 };
export interface CameraPathSegment { start: Vector3; end: Vector3; time: number; end_time: number; error: number }
export interface CameraCollisionSurface { vertices: Float32Array; indices: Uint32Array; object_id: string | null; occludes: boolean }

export function cameraPathSegments(frames: readonly CameraKeyframe[], pivot: Vector3): CameraPathSegment[] {
  if (!pivot.toArray().every(Number.isFinite) || frames.length < 2 || frames.length > 12 || frames[0]!.time !== 0 || frames.at(-1)!.time !== 1
    || frames.some((f, i) => ![f.time, f.azimuth, f.elevation, f.distance].every(Number.isFinite)
      || f.distance <= 0 || f.distance > 10000 || Math.abs(f.azimuth) > 720 || Math.abs(f.elevation) > 89
      || i > 0 && f.time - frames[i - 1]!.time < 0.009999)) throw new Error("Invalid camera path");
  const segments: CameraPathSegment[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!;
    const angle = MathUtils.degToRad(Math.abs(b.azimuth - a.azimuth) + Math.abs(b.elevation - a.elevation));
    const radius = Math.max(a.distance, b.distance), dr = Math.abs(b.distance - a.distance);
    // For p(t)=r(t)u(az(t),el(t)), ||p''|| <= 2|r'|A+r_max*A^2.
    // Linear interpolation error is <= max||p''||*dt^2/8. Inflate each
    // swept sphere by this bound so curved travel is enclosed by its chords.
    const curvature = 2 * dr * angle + radius * angle * angle;
    const count = Math.max(1, Math.ceil(Math.sqrt(curvature / (8 * MAX_ERROR))), Math.ceil((dr + radius * angle) / VISIBILITY_STEP));
    if (segments.length + count > MAX_SEGMENTS) throw new Error("Camera path is too complex to check. Shorten its turns or distance.");
    let time = a.time, start = orbitPosition(pivot, a);
    for (let j = 1; j <= count; j++) {
      const endTime = j === count ? b.time : a.time + (b.time - a.time) * j / count;
      const end = orbitPosition(pivot, sampleCameraPath(frames, endTime));
      segments.push({ start, end, time, end_time: endTime, error: curvature / (8 * count * count) });
      start = end; time = endTime;
    }
  }
  return segments;
}

export async function createCameraPathChecker(solids: readonly Solid[], surfaces: readonly CameraCollisionSurface[] = []) {
  const R = await loadPlacePhysics(), world = new R.World({ x: 0, y: 0, z: 0 });
  const visibleSurfaces = new Map<number, string | null>();
  let freed = false;
  try {
    for (const solid of solids) world.createCollider(placeCollider(R, solid));
    for (const surface of surfaces) {
      const collider = world.createCollider(R.ColliderDesc.trimesh(surface.vertices, surface.indices));
      if (surface.occludes) visibleSurfaces.set(collider.handle, surface.object_id);
    }
    world.step();
  }
  catch (error) { world.free(); throw error; }
  return {
    free() { if (!freed) { freed = true; world.free(); } },
    check(frames: readonly CameraKeyframe[], pivot: Vector3, clearance = 0.2, targetId?: string): CameraPathCheck {
      if (freed) throw new Error("Camera geometry is no longer available");
      if (!Number.isFinite(clearance) || clearance < 0.2 || clearance > 5) throw new Error("Unsupported camera clearance");
      const segments = cameraPathSegments(frames, pivot), issues: CameraPathIssue[] = [];
      const visible = (position: Vector3) => {
        const direction = pivot.clone().sub(position), distance = direction.length();
        if (distance < 1e-6) return false;
        const hit = world.castRay(new R.Ray(position, direction.normalize()), distance + 0.001, true,
          undefined, undefined, undefined, undefined, collider => visibleSurfaces.has(collider.handle));
        return !!hit && visibleSurfaces.get(hit.collider.handle) === targetId;
      };
      const add = (kind: CameraPathIssue["kind"], segment: CameraPathSegment) => {
        const previous = issues.at(-1);
        if (previous?.kind === kind && previous.end_time === segment.time) previous.end_time = segment.end_time;
        else if (issues.length < 32) issues.push({ kind, time: segment.time, end_time: segment.end_time });
      };
      for (const segment of segments) {
        const sphere = new R.Ball(clearance + segment.error), velocity = segment.end.clone().sub(segment.start);
        const collision = world.intersectionWithShape(segment.start, rotation, sphere)
          || world.intersectionWithShape(segment.end, rotation, sphere)
          || velocity.lengthSq() > 1e-12 && world.castShape(segment.start, rotation, velocity, sphere, 0, 1, true);
        if (collision) add("collision", segment);
        if (targetId && (!visible(segment.start) || !visible(segment.end))) add("occluded", segment);
      }
      return { status: issues.length ? "blocked" : "clear", samples: segments.length + 1, clearance, visibility: targetId ? "sampled" : "not_requested", issues };
    },
  };
}
