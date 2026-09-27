import { expect, it } from "vitest";
import { newComponent, emptyPlaceScene, parsePlaceScene, sceneChanges } from "./place-scene";
import { materialAssetIds } from "./surface-material";
import { validateAssetBytes } from "./asset-pipeline";
import { fixtureMaterial } from "../e2e/fixtures/material-jpeg";

const binding = { asset_id: "material1", tile_metres: 2, rotation: 0, roughness: 0.85 };
it("persists ground and path appearance with canonical bindings and no geometry changes", () => {
  const path = newComponent("path", 10, 10), before = { ...emptyPlaceScene(), objects: [path] };
  const after = parsePlaceScene({ ...before, ground_material: { ...binding, ignored: "not saved" }, objects: [{ ...path, materials: { floor: binding } }] });
  expect(after.ground_material).toEqual(binding);
  expect(after.objects[0]).toEqual({ ...path, materials: { floor: binding } });
  expect(materialAssetIds(after)).toEqual([binding.asset_id]);
  expect(sceneChanges(before, after)).toEqual(["Update ground material", `Update ${path.label}`]);
  expect(parsePlaceScene({ ...before, version: 1 }).version).toBe(1);
});
it("rejects malformed ground bindings and non-floor path surfaces", () => {
  for (const ground_material of [null, [], "asset", { ...binding, tile_metres: "2" }, { ...binding, asset_id: "../foreign" }]) {
    expect(() => parsePlaceScene({ ...emptyPlaceScene(), ground_material })).toThrow("surface material");
  }
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...newComponent("path", 10, 10), materials: { wall: binding } }] })).toThrow("surface material");
});
it("canonicalizes material bindings without changing geometry", () => {
  const object = newComponent("building", 10, 10), before = { ...emptyPlaceScene(), objects: [object] };
  const after = parsePlaceScene({ ...before, objects: [{ ...object, materials: { wall: binding, roof: binding } }] });
  const { materials, ...unchanged } = after.objects[0]!;
  expect(unchanged).toEqual(object); expect(materials).toEqual({ wall: binding, roof: binding });
  expect(materialAssetIds(after)).toEqual(["material1"]); expect(sceneChanges(before, after)).toEqual([`Update ${object.label}`]);
  expect(parsePlaceScene({ ...before, objects: [{ ...object, materials: {} }] })).toEqual(before);
});
it("rejects invalid surfaces, kinds, IDs, tile dimensions, rotation and roughness", () => {
  const object = newComponent("building", 10, 10);
  for (const patch of [{ asset_id: "../secret" }, { tile_metres: 0 }, { tile_metres: Infinity }, { roughness: -1 }, { roughness: 2 }, { rotation: NaN }]) {
    expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...object, materials: { wall: { ...binding, ...patch } } }] })).toThrow("surface material");
  }
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...object, materials: { glass: binding } }] })).toThrow("surface material");
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...newComponent("bench", 5, 5), materials: { wall: binding } }] })).toThrow("structured building");
});
it("decodes bounded JPEGs as color only and rejects corrupt or foreign formats", () => {
  expect(validateAssetBytes("material", fixtureMaterial())).toEqual({ image: { width: 256, height: 256, channel: "base_color", color_space: "srgb", tiling: "unverified" } });
  expect(() => validateAssetBytes("material", Buffer.from("<svg/>"))).toThrow("JPEG");
  expect(() => validateAssetBytes("material", new Uint8Array([255, 216, 0, 0]))).toThrow();
  expect(() => validateAssetBytes("material", new Uint8Array(13 * 1024 * 1024))).toThrow("12 MiB");
});
