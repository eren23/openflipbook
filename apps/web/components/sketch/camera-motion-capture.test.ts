import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView, ViewCapture, ViewSource } from "@/lib/place-view";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import { orbitPosition } from "@/lib/camera-path";
import { prepareCameraMotion } from "@/lib/camera-motion";
import { motionComparisonPlan } from "@/lib/motion-comparison";
import { captureMotionReferences, type MotionPreparation } from "./camera-motion-capture";
import { capturePlaceView } from "./place-view-capture";
import { loadSurfaceMaterials } from "./surface-materials";
import { loadGeneratedMeshes } from "./generated-mesh";
const physics = vi.hoisted(() => ({ check: vi.fn(), free: vi.fn() }));
vi.mock("@/lib/camera-path-check", async original => ({ ...(await original<object>()), createCameraPathChecker: vi.fn(async () => physics) }));
vi.mock("./place-view-capture", () => ({ capturePlaceView: vi.fn() }));
vi.mock("./surface-materials", () => ({ loadSurfaceMaterials: vi.fn().mockResolvedValue(0) }));
vi.mock("./generated-mesh", () => ({ loadGeneratedMeshes: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./street-materials", () => ({ applyRoofMaterials: vi.fn(), applyStreetMaterials: vi.fn().mockResolvedValue(0) }));

function fixture() {
  const object = { ...newComponent("building", 5, 5), id: "inn" };
  const snapshot: PlaceSceneSnapshot = { id: "scene", place_id: "place", session_id: "world", revision: 1,
    source_node_id: null, source_image_key: null, updated_at: "2026-09-14T00:00:00Z",
    definition: { ...emptyPlaceScene(), objects: [object] } };
  const pivot = new THREE.Vector3(5, object.height / 2, 5), pose = { azimuth: 0, elevation: 20, distance: 20 };
  const camera = new THREE.PerspectiveCamera(50, 2, .3, 200);
  camera.position.copy(orbitPosition(pivot, pose)); camera.lookAt(pivot); camera.updateMatrixWorld();
  const source: ViewSource = { scene_id: snapshot.id, place_id: snapshot.place_id, revision: 1, x: 0, z: 0, definition: snapshot.definition };
  const { definition: _definition, ...binding } = source;
  const view: SavedPlaceView = { id: "view", version: 1, label: "Inn approach", created_at: snapshot.updated_at,
    root_place_id: "place", mode: "orbit", width: 64, height: 32, floor_id: null, historical: false,
    provenance: "client_rendered_saved_geometry", assets: [],
    sources: [{ ...binding, definition_sha256: createHash("sha256").update(JSON.stringify(snapshot.definition)).digest("hex") }],
    camera: { projection: "perspective", near: camera.near, far: camera.far, world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() },
    depth: { encoding: "linear_view_z_8bit_near_white", near: .3, far: 200 }, normals: "view_space_rgb", surface_policy: "opaque_geometry",
    objects: [{ object_id: "inn", rgb: [1, 2, 3] }],
    path: { version: 1, duration: 6, time: 0, pivot: pivot.toArray(), target_id: "inn", keyframes: [{ ...pose, time: 0 }, { ...pose, azimuth: 20, distance: 15, time: 1 }] } };
  const capture: ViewCapture = { ...view, sources: [source], passes: { render: "", depth: "", normals: "", objects: "" } };
  const preparation: MotionPreparation = { ...prepareCameraMotion(capture), preparation_sha256: "test-preparation", generation_enabled: false, status: "calibration_required",
    source: { view_id: view.id, view_input_sha256: "input", image: { kind: "render", asset_id: null, sha256: "render", width: view.width, height: view.height },
      registration: "saved_camera_dependency_not_visual_attestation", sources: view.sources, assets: [] } };
  const renderer = { shadowMap: { needsUpdate: false } } as THREE.WebGLRenderer;
  return { view, snapshot, preparation, renderer, abort: new AbortController() };
}
beforeEach(() => {
  vi.clearAllMocks();
  physics.check.mockReturnValue({ status: "clear", samples: 40, clearance: .2, visibility: "sampled", issues: [] });
  vi.mocked(capturePlaceView).mockImplementation((_renderer, _scene, camera, sources, mode, floor, size, onPixels) => {
    const rgba = new Uint8ClampedArray(size!.width * size!.height * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    rgba.set([1, 2, 3, 255], (size!.width + 1) * 4);
    onPixels?.(rgba, size!.width, size!.height);
    return { version: 1, mode, floor_id: floor ?? null, width: size!.width, height: size!.height, sources,
      camera: { world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() },
      passes: { render: "png", depth: "png", normals: "png", objects: "png" } } as ViewCapture;
  });
});
it("loads one shared scene and captures every exact prepared camera with landmark masks", async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const result = await captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, { mesh: "/meshes", material: "/materials" }, f.abort.signal);
  expect(loadSurfaceMaterials).toHaveBeenCalledTimes(1); expect(loadGeneratedMeshes).toHaveBeenCalledTimes(1);
  expect(result.frames).toHaveLength(5); expect(result.provenance).toBe("local_geometry_reference_not_provider_video");
  expect(result.comparison).toEqual(motionComparisonPlan({ preparation: f.preparation,
    source: { view: f.view, definitions: [{ definition: f.snapshot.definition }] }, frames: result.frames }));
  expect(result.comparison.issues).toContain("Two measurable neighboring landmarks are required throughout the path");
  for (const [i, frame] of result.frames.entries()) {
    expect(frame.capture.camera.world_matrix).toEqual(f.preparation.reference_cameras[i]!.world_matrix);
    expect(frame.capture.camera.projection_matrix).toEqual(f.view.camera.projection_matrix);
    expect(frame.measurements.landmarks[0]).toMatchObject({ object_id: "inn", pixels: 1 });
  }
  const p = f.view.camera.projection_matrix, near = f.view.camera.near;
  expect(physics.check.mock.calls[0]![2]).toBeCloseTo(Math.hypot(near, near / p[0]!, near / p[5]!));
  expect(physics.free).toHaveBeenCalledTimes(1); expect(f.renderer.shadowMap.needsUpdate).toBe(false);
  expect(f.snapshot).toEqual(before);
});
it("rejects stale geometry and preparation mismatches instead of approximating a new path", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.snapshot.revision++; }, f => { f.snapshot.definition.objects[0]!.height++; },
    f => { f.view.historical = true; }, f => { f.preparation.parameters.duration = 9; },
    f => { f.preparation.reference_cameras[1]!.world_matrix[12]!++; },
    f => { f.view.path!.time = .5; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await expect(captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, {}, f.abort.signal)).rejects.toThrow();
  }
  expect(capturePlaceView).not.toHaveBeenCalled();
});
it("allows only numerical roundoff in cross-platform reference recomputation", async () => {
  const f = fixture();
  f.preparation.reference_cameras[1]!.world_matrix[0]! += 1e-14;
  const result = await captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, {}, f.abort.signal);
  expect(result.frames).toHaveLength(5);
  const broken = fixture(); broken.preparation.reference_cameras[1]!.world_matrix[0]! += 1e-6;
  await expect(captureMotionReferences(broken.renderer, broken.view, broken.snapshot, broken.preparation, {}, broken.abort.signal)).rejects.toThrow("Prepared camera path changed");
});
it("retains blocked preflight as failure evidence rather than labeling the path clear", async () => {
  const f = fixture(); physics.check.mockReturnValue({ status: "blocked", samples: 1, clearance: .2, visibility: "sampled", issues: [{ kind: "occluded", time: 0, end_time: 1 }] });
  const result = await captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, {}, f.abort.signal);
  expect(result.preflight.status).toBe("blocked"); expect(result.frames).toHaveLength(5);
});
it("stops between frames on abort and releases physics and renderer state", async () => {
  const f = fixture(), normal = vi.mocked(capturePlaceView).getMockImplementation()!;
  vi.mocked(capturePlaceView).mockImplementationOnce((...args) => { const result = normal(...args); f.abort.abort(); return result; });
  await expect(captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, {}, f.abort.signal)).rejects.toThrow();
  expect(capturePlaceView).toHaveBeenCalledTimes(1); expect(physics.free).toHaveBeenCalledTimes(1);
  expect(f.renderer.shadowMap.needsUpdate).toBe(false);
});
it("restores state and releases physics when rendering fails", async () => {
  const f = fixture(); vi.mocked(capturePlaceView).mockImplementationOnce(() => { throw new Error("GPU lost"); });
  await expect(captureMotionReferences(f.renderer, f.view, f.snapshot, f.preparation, {}, f.abort.signal)).rejects.toThrow("GPU lost");
  expect(physics.free).toHaveBeenCalledTimes(1); expect(f.renderer.shadowMap.needsUpdate).toBe(false);
});
