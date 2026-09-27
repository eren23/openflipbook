import type { PlaceSceneObject } from "@openflipbook/config";
import { MathUtils, Vector3 } from "three";

// The renderer uses -heading around Y. Choose the doorway's exterior quarter,
// then fit a bounding sphere in the narrower field of view (including mobile).
export function objectCameraFrame(object: PlaceSceneObject & { elevation: number }, fov: number, aspect: number, minDistance = 2) {
  if (![fov, aspect, minDistance].every(Number.isFinite) || fov <= 0 || fov >= 180 || aspect <= 0 || minDistance < 0) throw new Error("Invalid camera framing");
  const side = object.structure?.door.side;
  const normal = side ? { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[side]! : null;
  const direction = normal ? new Vector3(normal[0]! + normal[1]! * 0.4, 0.6, normal[1]! - normal[0]! * 0.4) : new Vector3(1, 0.8, -1);
  direction.applyAxisAngle(new Vector3(0, 1, 0), -object.heading).normalize();
  const vfov = MathUtils.degToRad(fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const radius = Math.hypot(object.width, object.height, object.depth) / 2;
  const distance = Math.max(minDistance, radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.15);
  const target = new Vector3(object.x, object.elevation + object.height / 2, object.z);
  return { target, position: target.clone().addScaledVector(direction, distance), distance, radius };
}
