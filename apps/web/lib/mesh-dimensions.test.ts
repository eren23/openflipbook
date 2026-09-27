import { expect, it } from "vitest";
import { newComponent, parsePlaceScene, emptyPlaceScene } from "./place-scene";
import { assertMeshProportions, proportionalMeshDimensions, resizeMesh } from "./mesh-dimensions";

const source = { width: 2, height: 4, depth: 3 };
it("fits the source into an authored envelope without squashing it", () => {
  expect(proportionalMeshDimensions(source, { width: 3, height: 3, depth: 3 })).toEqual({ width: 1.5, height: 3, depth: 2.25 });
});
it("resizes a locked object along all three axes and preserves bindings", () => {
  const object = { ...newComponent("mesh", 5, 5), ...source, mesh_scale: "uniform" as const, asset_id: "asset" };
  expect(resizeMesh(object, { width: 4 })).toEqual({ ...object, width: 4, height: 8, depth: 6 });
  expect(resizeMesh(object, { height: 8 })).toEqual({ ...object, width: 4, height: 8, depth: 6 });
  expect(resizeMesh(object, { depth: 6 })).toEqual({ ...object, width: 4, height: 8, depth: 6 });
  expect(resizeMesh(object, { heading: 1 })).toEqual({ ...object, heading: 1 });
  expect(() => resizeMesh(object, { height: 0 })).toThrow("invalid bounds");
});
it("retains legacy and explicitly stretched shapes", () => {
  for (const mesh_scale of [undefined, "stretch"] as const) {
    const object = { ...newComponent("mesh", 5, 5), ...source, ...(mesh_scale ? { mesh_scale } : {}) };
    expect(resizeMesh(object, { width: 4 })).toEqual({ ...object, width: 4 });
  }
});
it("rejects distorted locked dimensions, allowing floating-point roundoff only", () => {
  expect(() => assertMeshProportions(source, { width: 3, height: 3, depth: 3 })).toThrow("proportions");
  expect(() => assertMeshProportions(source, { width: 4, height: 8.000000001, depth: 6 })).not.toThrow();
  expect(() => proportionalMeshDimensions({ ...source, width: NaN }, source)).toThrow("invalid bounds");
});
it("round-trips explicit modes, does not migrate missing modes, and rejects foreign fields", () => {
  const object = { ...newComponent("mesh", 5, 5), asset_id: "asset" };
  for (const mesh_scale of [undefined, "uniform", "stretch"] as const) {
    const parsed = parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...object, mesh_scale }] });
    expect(parsed.objects[0]?.mesh_scale).toBe(mesh_scale);
    if (!mesh_scale) expect(parsed.objects[0]).not.toHaveProperty("mesh_scale");
  }
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...object, mesh_scale: "auto" }] })).toThrow("scaling mode");
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...newComponent("bench", 5, 5), mesh_scale: "uniform" }] })).toThrow("scaling mode");
});
