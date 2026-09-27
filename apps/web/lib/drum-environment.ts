import { Vector3, PerspectiveCamera } from "three";

export const DRUM_CAMERA = {
  position: [27, 2.2, 9.4] as [number, number, number],
  target: [13, 2.8, 15.7] as [number, number, number],
  fov: 60,
};
export function environmentCamera() {
  const camera = new PerspectiveCamera(DRUM_CAMERA.fov, 16 / 9, 0.05, 400);
  camera.position.fromArray(DRUM_CAMERA.position);
  camera.lookAt(new Vector3(...DRUM_CAMERA.target));
  camera.updateMatrixWorld();
  return camera;
}
export function projectEnvironmentPoint(point: [number, number, number]) {
  const projected = new Vector3(...point).project(environmentCamera());
  return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2, visible: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1 };
}
