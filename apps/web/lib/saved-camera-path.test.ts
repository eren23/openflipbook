import { expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { parseSavedCameraPath } from "./saved-camera-path";
import { orbitPosition, sampleCameraPath, type CameraPathDraft } from "./camera-path";
import type { ViewCamera, ViewSource } from "./place-view";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { resolveSceneObject } from "./floor-placement";

function fixture() {
  const building = { ...newComponent("building", 8, 10), id: "building" };
  const source: ViewSource = { scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition: { ...emptyPlaceScene(), objects: [building] } };
  const path: CameraPathDraft = { version: 1, duration: 6, time: 0.4, pivot: [building.x, building.height / 2, building.z], target_id: building.id,
    keyframes: [{ time: 0, azimuth: 0, elevation: 30, distance: 20 }, { time: 1, azimuth: 180, elevation: 40, distance: 30 }] };
  return { source, path, camera: cameraFor(path) };
}
function cameraFor(path: CameraPathDraft): ViewCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.05, 400), pivot = new Vector3(...path.pivot);
  camera.position.copy(orbitPosition(pivot, sampleCameraPath(path.keyframes, path.time))); camera.lookAt(pivot); camera.updateMatrixWorld();
  return { projection: "perspective", near: camera.near, far: camera.far, world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() };
}
it("preserves a target-bound path, independently copies it and drops unsupported attestation fields", () => {
  const { path, camera, source } = fixture();
  const parsed = parseSavedCameraPath({ ...path, checked: true, provider: "not-authoritative" }, camera, [source]);
  expect(parsed).toEqual(path); expect(parsed).not.toBe(path); expect(parsed.keyframes).not.toBe(path.keyframes);
  path.pivot[0]++; expect(parsed.pivot).not.toEqual(path.pivot);
});
it("binds the sample's exact position, orientation and projection type", () => {
  const { path, camera, source } = fixture();
  for (const mutate of [(c: ViewCamera) => c.world_matrix[12]!++, (c: ViewCamera) => { c.world_matrix[0] = 0.1; }, (c: ViewCamera) => { c.projection = "orthographic"; }, (c: ViewCamera) => { c.projection_matrix[8] = 0.1; }]) {
    const changed = structuredClone(camera); mutate(changed); expect(() => parseSavedCameraPath(path, changed, [source])).toThrow();
  }
});
it("rejects malformed, unordered, excessively complex and mismatched target metadata", () => {
  const { path, camera, source } = fixture();
  for (const raw of [null, {}, { ...path, duration: 0 }, { ...path, duration: "6" }, { ...path, time: 2 }, { ...path, time: NaN }, { ...path, pivot: [0, 0] }, { ...path, pivot: [NaN, 0, 0] }, { ...path, target_id: "missing" }, { ...path, target_id: "../bad" }, { ...path, keyframes: [null, null] }, { ...path, keyframes: path.keyframes.toReversed() }, { ...path, keyframes: path.keyframes.map(f => ({ ...f, distance: 10000 })) }, { ...path, pivot: [0, 0, 0] }]) expect(() => parseSavedCameraPath(raw, camera, [source])).toThrow();
  expect(() => parseSavedCameraPath(path, camera, [{ ...source, definition: {} as ViewSource["definition"] }])).toThrow();
});
it("resolves target placement through parent rotation and upper-floor elevation", () => {
  const { source, path } = fixture(), building = source.definition.objects[0]!;
  building.height = 7.8; building.heading = Math.PI / 2; building.structure!.floors.push({ id: "upper", label: "Upper" });
  const furnishing = { ...newComponent("bench", 1, 1), id: "furnishing", placement: { building_id: building.id, floor_id: "upper" } };
  source.definition.objects.push(furnishing); source.x = 20; source.z = -10;
  const placed = resolveSceneObject(source.definition, furnishing);
  path.target_id = furnishing.id; path.pivot = [placed.x + source.x, placed.elevation + placed.height / 2, placed.z + source.z];
  expect(parseSavedCameraPath(path, cameraFor(path), [source])).toEqual(path);
  const wrong = { ...path, pivot: [furnishing.x, furnishing.height / 2, furnishing.z] as [number, number, number] };
  expect(() => parseSavedCameraPath(wrong, cameraFor(wrong), [source])).toThrow();
});
it("allows a custom pivot but still requires exact camera registration", () => {
  const { path, source } = fixture(); path.target_id = null; path.pivot = [10, 2, 12];
  expect(parseSavedCameraPath(path, cameraFor(path), [source])).toEqual(path);
});
