import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { orbitPosition, sampleCameraPath } from "./camera-path";
import { prepareCameraMotion, h3SentDistance, H3_CAMERA_MODEL, H3_CAMERA_ADAPTER_V1, H3_LIMITS, H3_NOTES } from "./camera-motion";
import { emptyPlaceScene, newComponent } from "./place-scene";
import type { ViewCapture } from "./place-view";

function fixture(): ViewCapture {
  const building = { ...newComponent("building", 8, 10), id: "inn" };
  const capture: ViewCapture = {
    version: 1, mode: "orbit", width: 960, height: 540, floor_id: null,
    camera: { projection: "perspective", near: 0.05, far: 400, world_matrix: [], projection_matrix: [] },
    depth: { encoding: "linear_view_z_8bit_near_white", near: 0.05, far: 400 },
    normals: "view_space_rgb", surface_policy: "opaque_geometry", objects: [{ object_id: "inn", rgb: [1, 2, 3] }],
    passes: { render: "", depth: "", normals: "", objects: "" },
    sources: [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition: { ...emptyPlaceScene(), objects: [building] } }],
    path: { version: 1, duration: 6, time: 0, pivot: [8, building.height / 2, 10], target_id: "inn",
      keyframes: [{ time: 0, azimuth: 170, elevation: 20, distance: 20 }, { time: 1, azimuth: 190, elevation: 30, distance: 10 }] },
  };
  recapture(capture);
  return capture;
}
function recapture(c: ViewCapture) {
  const p = c.path!, pivot = new Vector3(...p.pivot), camera = new PerspectiveCamera(60, c.width / c.height, 0.05, 400);
  camera.position.copy(orbitPosition(pivot, sampleCameraPath(p.keyframes, p.time))); camera.lookAt(pivot); camera.updateMatrixWorld();
  c.camera.world_matrix = camera.matrixWorld.toArray(); c.camera.projection_matrix = camera.projectionMatrix.toArray();
}

describe("source-bound H3 camera preparation", () => {
  it("keeps the v1 hypothesis output byte-for-byte for archived studies", () => {
    const c = fixture(), before = structuredClone(c), plan = prepareCameraMotion(c, H3_CAMERA_ADAPTER_V1);
    expect(plan.model).toBe(H3_CAMERA_MODEL);
    expect(plan.adapter).toBe(H3_CAMERA_ADAPTER_V1);
    expect(plan.calibration).toBe("unverified");
    expect(Object.keys(plan)).toEqual(["model", "adapter", "calibration", "schema", "parameters", "mapping", "path", "reference_cameras", "checks_required"]);
    expect(plan.parameters.camera_trajectory).toEqual([
      { time: 0, azimuth: 0, elevation: 0, distance: 1 },
      { time: 1, azimuth: 20, elevation: 10, distance: 0.5 },
    ]);
    expect(plan.reference_cameras.map(frame => frame.time)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(plan.parameters).not.toHaveProperty("end_image_url");
    expect(plan.parameters).not.toHaveProperty("depth");
    expect(plan.parameters).not.toHaveProperty("image_url");
    expect(plan.checks_required).toContain("provider_axis_and_distance_calibration");
    expect(c).toEqual(before);
    plan.path.keyframes[0]!.azimuth = 50;
    expect(c).toEqual(before);
  });
  it("compensates the measured H3 push gain and labels what arrives", () => {
    const c = fixture(); c.path!.keyframes[1]!.distance = 15.8;
    const plan = prepareCameraMotion(c);
    expect(plan.adapter).toBe("h3-source-relative-v2-measured");
    expect(plan.calibration).toBe("measured");
    expect(plan.parameters.camera_trajectory[0]).toEqual({ time: 0, azimuth: 0, elevation: 0, distance: 1 });
    expect(plan.parameters.camera_trajectory[1]).toMatchObject({ time: 1, azimuth: 20, elevation: 10 });
    expect(plan.parameters.camera_trajectory[1]!.distance).toBeCloseTo(0.65, 12);
    expect(plan.limit_issues).toEqual([]);
    expect(plan.calibration_notes).toEqual([H3_NOTES.azimuth, H3_NOTES.elevation]);
    expect(h3SentDistance(0.3)).toBe(0.2);
    expect(h3SentDistance(1)).toBe(1);
    c.path!.keyframes[1]!.distance = 24;
    expect(prepareCameraMotion(c).parameters.camera_trajectory[1]!.distance).toBe(1.2);
    expect(prepareCameraMotion(c).calibration_notes).toContain(H3_NOTES.pull_back);
    c.path!.keyframes[1]!.distance = 6;
    expect(prepareCameraMotion(c).calibration_notes).toContain(H3_NOTES.push_floor);
  });
  it("flags moves beyond the measured H3 turn and rise limits", () => {
    const c = fixture(); c.path!.keyframes[1]!.distance = 18;
    c.path!.keyframes[1]!.azimuth = 200; c.path!.keyframes[1]!.elevation = 35;
    expect(prepareCameraMotion(c).limit_issues).toEqual([]);
    c.path!.keyframes[1]!.azimuth = 201; c.path!.keyframes[1]!.elevation = 36;
    expect(prepareCameraMotion(c).limit_issues).toHaveLength(2);
    expect(H3_LIMITS).toEqual({ distance_gain: 0.6, min_distance: 0.2, max_azimuth_deg: 30, max_elevation_deg: 15 });
  });
  it("preserves negative motion and authored full turns instead of wrapping", () => {
    const c = fixture(); c.path!.keyframes[1]!.azimuth = -170;
    expect(prepareCameraMotion(c, H3_CAMERA_ADAPTER_V1).parameters.camera_trajectory[1]!.azimuth).toBe(-340);
    expect(prepareCameraMotion(c).parameters.camera_trajectory[1]!.azimuth).toBe(-340);
    expect(prepareCameraMotion(c).limit_issues).toHaveLength(1);
    c.path!.keyframes[1]!.azimuth = 530;
    expect(prepareCameraMotion(c, H3_CAMERA_ADAPTER_V1).parameters.camera_trajectory[1]!.azimuth).toBe(360);
    c.path!.keyframes[1]!.azimuth = 150;
    expect(prepareCameraMotion(c).parameters.camera_trajectory[1]!.azimuth).toBe(-20);
  });
  it("refuses a v2 path that needs more than 12 keyframe checkpoints", () => {
    const c = fixture(); c.path!.keyframes[0]!.elevation = 0; c.path!.keyframes[1]!.elevation = 0;
    c.path!.keyframes[1]!.azimuth = -170; recapture(c);
    expect(() => prepareCameraMotion(c)).toThrow(/12 keyframe checkpoints/);
    expect(prepareCameraMotion(c, H3_CAMERA_ADAPTER_V1).reference_cameras).toHaveLength(5);
  });
  it("adds keyframe checkpoints only where the path needs them", () => {
    const c = fixture(); c.path!.keyframes[1]!.distance = 15;
    const v1 = prepareCameraMotion(c, H3_CAMERA_ADAPTER_V1), v2 = prepareCameraMotion(c);
    expect(v2.reference_cameras).toEqual(v1.reference_cameras);
    expect(v2.checkpoints).toEqual([0, 4]);
    // At zero elevation the great-circle angle equals the turn, so 90 degrees is 3 legs.
    c.path!.keyframes[0]!.elevation = 0; c.path!.keyframes[1]!.elevation = 0;
    c.path!.keyframes[1]!.azimuth = 260; recapture(c);
    const arc = prepareCameraMotion(c);
    expect(arc.checkpoints!.map(i => arc.reference_cameras[i]!.time)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(arc.reference_cameras.map(frame => frame.time)).toEqual([0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]);
  });
  it("is invariant to world translation and uniform distance scaling", () => {
    const c = fixture(), initial = prepareCameraMotion(c);
    c.sources[0]!.x += 30; c.sources[0]!.z -= 10;
    c.path!.pivot[0] += 30; c.path!.pivot[2] -= 10;
    c.path!.keyframes.forEach(frame => { frame.distance *= 2; }); recapture(c);
    expect(prepareCameraMotion(c).parameters).toEqual(initial.parameters);
    expect(prepareCameraMotion(c).mapping.distance_unit_metres).toBe(40);
  });
  it("retains exact source projection and intermediate world reference cameras", () => {
    const c = fixture(); c.path!.keyframes.splice(1, 0, { time: 0.3, azimuth: 176, elevation: 23, distance: 17 });
    const plan = prepareCameraMotion(c);
    // 17 m to 10 m passes the 1.5 distance ratio, so one checkpoint is added.
    expect(plan.reference_cameras.map(frame => frame.time)).toEqual([0, 0.25, 0.3, 0.5, 0.75, 208 / 240, 1]);
    expect(plan.checkpoints).toEqual([0, 2, 5, 6]);
    expect(plan.reference_cameras[0]!.world_matrix).toEqual(c.camera.world_matrix);
    for (const frame of plan.reference_cameras) {
      expect(frame.projection_matrix).toEqual(c.camera.projection_matrix);
      expect(frame.position).toEqual(orbitPosition(new Vector3(...c.path!.pivot), sampleCameraPath(c.path!.keyframes, frame.time)).toArray());
      expect(frame.seconds).toBe(frame.time * 6);
    }
  });
  it("rejects a source captured halfway through its path", () => {
    const c = fixture(); c.path!.time = 0.5; recapture(c);
    expect(() => prepareCameraMotion(c)).toThrow(/at its start/);
  });
  it("rejects unbound targets, interiors, changed orientation, malformed matrices and incompatible projections", () => {
    const mutations: ((c: ViewCapture) => void)[] = [
      c => { delete c.path; }, c => { c.path!.target_id = null; }, c => { c.path!.target_id = "missing"; },
      c => { c.floor_id = "upper"; }, c => { c.mode = "walk"; }, c => { c.sources.push(c.sources[0]!); },
      c => { c.camera.world_matrix[0]! += 0.1; }, c => { c.camera.world_matrix = []; },
      c => { c.camera.world_matrix[0] = NaN; }, c => { c.camera.projection_matrix[0] = Infinity; },
      c => { c.camera.projection_matrix[8] = 0.1; }, c => { c.camera.projection = "orthographic"; },
    ];
    for (const mutate of mutations) { const c = fixture(); mutate(c); expect(() => prepareCameraMotion(c)).toThrow(); }
  });
  it("rejects invalid duration, degenerate distance, ordering and relative elevation limits without clamping", () => {
    const mutations: ((c: ViewCapture) => void)[] = [
      c => { c.path!.duration = 6.5; }, c => { c.path!.duration = 16; },
      c => { c.path!.keyframes[1]!.distance = 0; }, c => { c.path!.keyframes[1]!.distance = NaN; },
      c => { c.path!.keyframes.reverse(); }, c => { c.path!.keyframes[1]!.time = 0; },
      c => { c.path!.keyframes[1]!.elevation = -89; },
    ];
    for (const mutate of mutations) { const c = fixture(); mutate(c); expect(() => prepareCameraMotion(c)).toThrow(); }
  });
});
