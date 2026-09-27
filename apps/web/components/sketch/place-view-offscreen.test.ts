import { beforeEach, expect, it, vi } from "vitest";
import { THREE } from "./place-scene-renderer";
import { refreshPlaceViewOffscreen } from "./place-view-refresh";
import { capturePlaceView } from "./place-view-capture";
import { loadGeneratedMeshes } from "./generated-mesh";
import { emptyPlaceScene } from "@/lib/place-scene";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView } from "@/lib/place-view";
import type * as SceneRenderer from "./place-scene-renderer";

vi.mock("./place-scene-renderer", async importOriginal => {
  const actual = await importOriginal<typeof SceneRenderer>();
  return { ...actual, THREE: { ...actual.THREE, WebGLRenderer: vi.fn() } };
});
vi.mock("./place-view-capture", () => ({ capturePlaceView: vi.fn() }));
vi.mock("./generated-mesh", () => ({ loadGeneratedMeshes: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./surface-materials", () => ({ loadSurfaceMaterials: vi.fn().mockResolvedValue(0) }));
vi.mock("./street-materials", () => ({ applyRoofMaterials: vi.fn() }));
const renderer = { shadowMap: { enabled: false, type: 0, autoUpdate: true }, outputColorSpace: "", dispose: vi.fn(), forceContextLoss: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(THREE.WebGLRenderer).mockImplementation(function () { return renderer as unknown as THREE.WebGLRenderer; }); });
it.each([false, true])("releases the offscreen WebGL context after refresh (asset failure %s)", async fails => {
  const snapshot = { id: "scene", place_id: "place", revision: 2, definition: emptyPlaceScene() } as PlaceSceneSnapshot;
  const matrix = new THREE.Matrix4().toArray();
  const view: SavedPlaceView = { id: "view", label: "Courtyard", version: 1, created_at: "2026-09-13T00:00:00Z", root_place_id: "place", historical: true, assets: [], provenance: "client_rendered_saved_geometry",
    sources: [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition_sha256: "old" }], mode: "orbit", width: 400, height: 300, floor_id: null,
    camera: { projection: "perspective", near: .1, far: 100, world_matrix: matrix, projection_matrix: matrix }, depth: { encoding: "linear_view_z_8bit_near_white", near: .1, far: 100 }, normals: "view_space_rgb", surface_policy: "opaque_geometry", objects: [] };
  if (fails) vi.mocked(loadGeneratedMeshes).mockRejectedValueOnce(new Error("Missing mesh"));
  const result = refreshPlaceViewOffscreen(view, snapshot, null, {}, new AbortController().signal);
  if (fails) await expect(result).rejects.toThrow("Missing mesh"); else await result;
  expect(renderer.dispose).toHaveBeenCalledOnce(); expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
  expect(capturePlaceView).toHaveBeenCalledTimes(fails ? 0 : 1);
});
it("does not allocate a WebGL context for a cancelled refresh", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(refreshPlaceViewOffscreen({} as SavedPlaceView, {} as PlaceSceneSnapshot, null, {}, abort.signal)).rejects.toThrow();
  expect(THREE.WebGLRenderer).not.toHaveBeenCalled();
});
