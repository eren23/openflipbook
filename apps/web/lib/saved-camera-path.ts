import { Matrix4, Vector3 } from "three";
import { cameraPathSegments } from "./camera-path-check";
import { orbitPosition, sampleCameraPath, type CameraPathDraft } from "./camera-path";
import { resolveSceneObject } from "./floor-placement";
import { isSafeId } from "./ids";
import { CreatorError } from "./creator-error";
import type { ViewCamera, ViewSource } from "./place-view";

export function parseSavedCameraPath(raw: unknown, camera: ViewCamera, sources: ViewSource[]): CameraPathDraft {
  const p = raw as CameraPathDraft;
  const fail = () => new CreatorError("Camera path does not match its captured view", 400);
  if (!p || p.version !== 1 || !Number.isFinite(p.duration) || p.duration < 5 || p.duration > 15
    || !Number.isFinite(p.time) || p.time < 0 || p.time > 1 || !Array.isArray(p.pivot) || p.pivot.length !== 3
    || p.pivot.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 100000)
    || p.target_id !== null && !isSafeId(p.target_id) || !Array.isArray(p.keyframes) || p.keyframes.length < 2 || p.keyframes.length > 12
    || p.keyframes.some(f => !f || typeof f !== "object") || camera.projection !== "perspective"
    || ![camera.world_matrix, camera.projection_matrix].every(m => Array.isArray(m) && m.length === 16 && m.every(Number.isFinite))) throw fail();
  const pivot = new Vector3(...p.pivot);
  try { cameraPathSegments(p.keyframes, pivot); } catch { throw fail(); }
  if (p.target_id) {
    try {
      const matches = sources.flatMap(source => source.definition.objects.filter(o => o.id === p.target_id).map(o => ({ source, object: resolveSceneObject(source.definition, o) })));
      if (matches.length !== 1) throw fail();
      const { source, object } = matches[0]!;
      const centre = new Vector3(object.x + source.x, object.elevation + object.height / 2, object.z + source.z);
      if (!centre.toArray().every(Number.isFinite) || pivot.distanceTo(centre) > 1e-5) throw fail();
    } catch { throw fail(); }
  }
  const position = orbitPosition(pivot, sampleCameraPath(p.keyframes, p.time));
  const expected = new Matrix4().lookAt(position, pivot, new Vector3(0, 1, 0)).setPosition(position).elements;
  if (camera.world_matrix.some((n, i) => Math.abs(n - expected[i]!) > 1e-5)
    || Math.abs(camera.projection_matrix[8]!) > 1e-8 || Math.abs(camera.projection_matrix[9]!) > 1e-8) throw fail();
  return { version: 1, duration: p.duration, time: p.time, pivot: [...p.pivot], target_id: p.target_id,
    keyframes: p.keyframes.map(f => ({ time: f.time, azimuth: f.azimuth, elevation: f.elevation, distance: f.distance })) };
}
