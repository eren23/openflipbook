import { expect, it } from "vitest";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import { emptyPlaceScene } from "./place-scene";
import { assertGeometryMapCapture } from "./geometry-map";
import { geometryMapCamera } from "../components/sketch/geometry-map-capture";
import { newComponent } from "./place-scene";
it.each([[80, 80], [100, 20], [20, 100]])("covers a %s by %s metre world with an exact exterior map camera", (width, depth) => {
  const snapshot = { id: "scene", place_id: "place", revision: 1, definition: { ...emptyPlaceScene(), width, depth } } as PlaceSceneSnapshot;
  const view = geometryMapCamera(snapshot), capture = { ...view, sources: [{ ...view.sources[0]!, definition: snapshot.definition }] };
  expect(() => assertGeometryMapCapture(capture)).not.toThrow();
  expect(view).toMatchObject({ purpose: "map", mode: "plan", floor_id: null, width: 768, height: 768 });
  expect(() => assertGeometryMapCapture({ ...capture, floor_id: "upper" })).toThrow(/exterior/);
});
it("places the camera above tall objects even in a small authored world", () => {
  const snapshot = { id: "scene", place_id: "place", revision: 1, definition: { ...emptyPlaceScene(), width: 4, depth: 4, objects: [{ ...newComponent("volume", 2, 2), width: 1, depth: 1, height: 20 }] } } as PlaceSceneSnapshot;
  const view = geometryMapCamera(snapshot), capture = { ...view, sources: [{ ...view.sources[0]!, definition: snapshot.definition }] };
  expect(view.camera.world_matrix[13]).toBeGreaterThan(20); expect(() => assertGeometryMapCapture(capture)).not.toThrow();
  const clipped = { ...capture, camera: { ...capture.camera, world_matrix: [...capture.camera.world_matrix] } };
  clipped.camera.world_matrix[13] = 8;
  expect(() => assertGeometryMapCapture(clipped)).toThrow(/whole place/);
});
