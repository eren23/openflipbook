import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView, ViewCapture, ViewSource } from "@/lib/place-view";
import { emptyPlaceScene, newComponent, sceneGeos } from "@/lib/place-scene";
import { adjacentPlacement, placeNetwork } from "@/lib/place-connections";
import { refreshPlaceView } from "./place-view-refresh";
import { capturePlaceView } from "./place-view-capture";
import { loadSurfaceMaterials } from "./surface-materials";
import { loadGeneratedMeshes } from "./generated-mesh";

vi.mock("./place-view-capture", () => ({ capturePlaceView: vi.fn() }));
vi.mock("./surface-materials", () => ({ loadSurfaceMaterials: vi.fn().mockResolvedValue(0) }));
vi.mock("./generated-mesh", () => ({ loadGeneratedMeshes: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./street-materials", () => ({ applyRoofMaterials: vi.fn(), applyStreetMaterials: vi.fn().mockResolvedValue(0) }));

function fixture(mode: ViewCapture["mode"] = "orbit") {
  const snapshot: PlaceSceneSnapshot = { id: "scene_place", place_id: "place", session_id: "world", revision: 2, source_node_id: null, source_image_key: null, updated_at: "2026-09-13T00:00:00Z",
    definition: { ...emptyPlaceScene(), width: 20, depth: 20, objects: [{ ...newComponent("volume", 5, 5), id: "building" }] } };
  const camera = mode === "plan" ? new THREE.OrthographicCamera(-12, 12, 9, -9, .1, 100) : new THREE.PerspectiveCamera(53, 1.7, .1, 150);
  camera.position.set(7, 9, 18); camera.lookAt(5, 0, 5); camera.updateMatrixWorld(true);
  const view = { id: "original", root_place_id: "place", floor_id: null, mode, width: 711, height: 419, historical: true,
    camera: { projection: mode === "plan" ? "orthographic" : "perspective", near: camera.near, far: camera.far, world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() },
    sources: [{ scene_id: snapshot.id, place_id: snapshot.place_id, revision: 1, x: 0, z: 0, definition_sha256: "old" }] } as SavedPlaceView;
  const renderer = { shadowMap: { needsUpdate: false } } as THREE.WebGLRenderer;
  return { snapshot, view, renderer, abort: new AbortController() };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(capturePlaceView).mockImplementation((_renderer, _scene, camera, sources, mode, floorId, dimensions) => {
    camera.updateMatrixWorld(true);
    return { mode, floor_id: floorId ?? null, width: dimensions!.width, height: dimensions!.height, sources,
      camera: { world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() } } as ViewCapture;
  });
});
afterEach(() => vi.restoreAllMocks());
it.each(["plan", "orbit", "walk"] as const)("recaptures %s with exact camera/dimensions and current sources, disposing temporary geometry", async mode => {
  const f = fixture(mode), old = structuredClone(f.snapshot), dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  const result = await refreshPlaceView(f.renderer, f.view, f.snapshot, null, { mesh: "/meshes", material: "/materials" }, f.abort.signal);
  expect(result.camera.world_matrix).toEqual(f.view.camera.world_matrix); expect(result.camera.projection_matrix).toEqual(f.view.camera.projection_matrix);
  expect(result).toMatchObject({ mode, width: 711, height: 419, floor_id: null, sources: [{ revision: 2, definition: f.snapshot.definition }] });
  expect(result).not.toHaveProperty("path"); expect(f.snapshot).toEqual(old);
  expect(loadGeneratedMeshes).toHaveBeenCalledWith(expect.any(THREE.Scene), f.snapshot.definition, "/meshes", f.abort.signal);
  expect(loadSurfaceMaterials).toHaveBeenCalledWith(expect.any(THREE.Scene), f.snapshot.definition, "/materials", f.abort.signal);
  expect(dispose).toHaveBeenCalled(); expect(f.renderer.shadowMap.needsUpdate).toBe(false);
});
it("captures both current walk chunks in the root coordinate frame", async () => {
  const f = fixture("walk"), next = { ...structuredClone(f.snapshot), id: "scene_next", place_id: "next" };
  next.definition.objects[0]!.id = "other";
  const geos = sceneGeos(f.snapshot, []); geos.push(adjacentPlacement(f.snapshot, next, "east", geos));
  const network = placeNetwork("place", [f.snapshot, next], geos, [{ version: 1, id: "link", kind: "boundary", width: 3, created_at: "2026-09-13T00:00:00Z", a: { place_id: "place", side: "east", offset: 10 }, b: { place_id: "next", side: "west", offset: 10 } }]);
  const result = await refreshPlaceView(f.renderer, f.view, f.snapshot, network, {}, f.abort.signal);
  expect(result.sources.map((s: ViewSource) => ({ id: s.place_id, x: s.x, z: s.z }))).toEqual(expect.arrayContaining([{ id: "place", x: 0, z: 0 }, { id: "next", x: 20, z: 0 }]));
  expect(loadSurfaceMaterials).toHaveBeenCalledTimes(2);
});
it("rejects missing floors and unrelated cameras before loading assets", async () => {
  const f = fixture();
  for (const view of [{ ...f.view, root_place_id: "other" }, { ...f.view, floor_id: "missing" }]) await expect(refreshPlaceView(f.renderer, view, f.snapshot, null, {}, f.abort.signal)).rejects.toThrow();
  expect(loadSurfaceMaterials).not.toHaveBeenCalled(); expect(capturePlaceView).not.toHaveBeenCalled();
});
it("cleans up and never captures after cancellation or missing asset failures", async () => {
  const f = fixture(), dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  vi.mocked(loadSurfaceMaterials).mockImplementationOnce(async () => { f.abort.abort(); return 0; });
  await expect(refreshPlaceView(f.renderer, f.view, f.snapshot, null, {}, f.abort.signal)).rejects.toThrow();
  expect(capturePlaceView).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalled();
  vi.mocked(loadGeneratedMeshes).mockRejectedValueOnce(new Error("Missing mesh"));
  await expect(refreshPlaceView(f.renderer, f.view, f.snapshot, null, {}, new AbortController().signal)).rejects.toThrow("Missing mesh");
  expect(capturePlaceView).not.toHaveBeenCalled();
});
it("restores renderer shadow state and releases the temporary scene after capture failure", async () => {
  const f = fixture(), dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  vi.mocked(capturePlaceView).mockImplementationOnce(() => { throw new Error("GPU lost"); });
  await expect(refreshPlaceView(f.renderer, f.view, f.snapshot, null, {}, f.abort.signal)).rejects.toThrow("GPU lost");
  expect(f.renderer.shadowMap.needsUpdate).toBe(false); expect(dispose).toHaveBeenCalled();
});
