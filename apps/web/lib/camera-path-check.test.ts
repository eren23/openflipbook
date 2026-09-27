import { expect, it, vi } from "vitest";
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from "three";
import { cameraPathSegments, createCameraPathChecker } from "./camera-path-check";
import { orbitPosition, sampleCameraPath } from "./camera-path";
import { cameraCollisionSurfaces } from "../components/sketch/camera-collision-surfaces";
vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error Rapier's bundled ESM entry has no declaration file.
  const rapierModule = await import("@dimforge/rapier3d-compat/rapier.es.js");
  return { default: rapierModule.default };
});

const pivot = new Vector3(0, 1, 0);
const arc = [{ time: 0, azimuth: -90, elevation: 0, distance: 5 }, { time: 1, azimuth: 90, elevation: 0, distance: 5 }];
const box = (x: number, y: number, z: number, w = 1, h = 1, d = 1, yaw = 0) => ({ x, y, z, w, h, d, yaw });
it("encloses curved signed turns in bounded-error segments, including variable radius/elevation", () => {
  const frames = [{ ...arc[0]!, azimuth: -360, elevation: -30, distance: 4 }, { ...arc[1]!, azimuth: 360, elevation: 50, distance: 12 }];
  const segments = cameraPathSegments(frames, pivot);
  expect(segments.length).toBeGreaterThan(10);
  for (const segment of segments) {
    expect(segment.error).toBeLessThanOrEqual(0.01);
    expect(segment.end.distanceTo(segment.start)).toBeLessThanOrEqual(0.251);
    for (const alpha of [0.25, 0.5, 0.75]) {
      const truth = orbitPosition(pivot, sampleCameraPath(frames, segment.time + (segment.end_time - segment.time) * alpha));
      const chord = segment.start.clone().lerp(segment.end, alpha);
      expect(truth.distanceTo(chord)).toBeLessThanOrEqual(segment.error + 1e-10);
    }
  }
});
it("rejects invalid, unordered, unbounded and excessively expensive paths", () => {
  for (const frames of [[], [arc[0]!], [{ ...arc[0]!, time: 0.1 }, arc[1]!], [{ ...arc[0]!, distance: NaN }, arc[1]!], [{ ...arc[0]!, elevation: 90 }, arc[1]!], [{ ...arc[0]!, distance: 0 }, arc[1]!], [arc[0]!, { ...arc[1]!, time: 0.5 }, { ...arc[1]!, time: 0.499 }, arc[1]!]]) expect(() => cameraPathSegments(frames, pivot)).toThrow();
  expect(() => cameraPathSegments(arc, new Vector3(NaN, 0, 0))).toThrow();
  expect(() => cameraPathSegments(arc.map(f => ({ ...f, distance: 10000 })), pivot)).toThrow(/too complex/);
});
it("accepts a clear orbit and frees its physics world idempotently", async () => {
  const checker = await createCameraPathChecker([box(0, -0.5, 0, 30, 1, 30)]);
  const result = checker.check(arc, pivot);
  expect(result.status).toBe("clear"); expect(result.visibility).toBe("not_requested"); expect(result.samples).toBeGreaterThan(2);
  checker.free(); checker.free(); expect(() => checker.check(arc, pivot)).toThrow(/no longer available/);
});
it("rejects an intermediate collision although both authored endpoints are clear", async () => {
  const checker = await createCameraPathChecker([box(0, 1, 5, 0.1, 2, 1, Math.PI / 4)]);
  try {
    for (const end of arc) expect(checker.check([{ ...end, time: 0 }, { ...end, time: 1 }], pivot).status).toBe("clear");
    const result = checker.check(arc, pivot); expect(result.status).toBe("blocked");
    expect(result.issues.some(issue => issue.kind === "collision" && issue.time > 0.3 && issue.time < 0.6)).toBe(true);
  } finally { checker.free(); }
});
it("sweeps a thin grazing obstacle between sample positions", async () => {
  const frames = [{ ...arc[0]!, azimuth: 0, distance: 5 }, { ...arc[1]!, azimuth: 0, distance: 10 }];
  const checker = await createCameraPathChecker([box(0.19, 1, 7.125, 0.001, 2, 0.001)]);
  try {
    const segments = cameraPathSegments(frames, pivot);
    expect(segments.every(segment => segment.start.distanceTo(new Vector3(0.19, 1, 7.125)) > 0.2)).toBe(true);
    expect(checker.check(frames, pivot).issues.some(issue => issue.kind === "collision")).toBe(true);
  } finally { checker.free(); }
});
it("checks stationary overlap and validates clearance", async () => {
  const checker = await createCameraPathChecker([box(0, 1, 5)]);
  const still = [{ ...arc[0]!, azimuth: 0 }, { ...arc[1]!, azimuth: 0 }];
  try {
    expect(checker.check(still, pivot).status).toBe("blocked");
    for (const radius of [NaN, 0, 0.1, 6]) expect(() => checker.check(still, pivot, radius)).toThrow(/clearance/);
  } finally { checker.free(); }
});
function mesh(scene: Scene, id: string, x: number, z: number, w: number, d: number) {
  const geometry = new BoxGeometry(w, 2, d), material = new MeshBasicMaterial(), object = new Mesh(geometry, material);
  object.position.set(x, 1, z); object.userData.objectId = id; scene.add(object); return object;
}
it("uses actual transformed roof surfaces even when no walking solid exists", async () => {
  const scene = new Scene(), roof = mesh(scene, "roof", 0, 5, 0.5, 1); roof.rotation.y = Math.PI / 4;
  const checker = await createCameraPathChecker([], cameraCollisionSurfaces(scene));
  try { expect(checker.check(arc, pivot).status).toBe("blocked"); }
  finally { checker.free(); roof.geometry.dispose(); roof.material.dispose(); }
});
it("samples actual target surfaces and catches an intermediate occluder without a camera collision", async () => {
  const scene = new Scene(), target = mesh(scene, "target", 0, 0, 1, 1), occluder = mesh(scene, "other", 0, 2.5, 1, 0.1);
  const checker = await createCameraPathChecker([], cameraCollisionSurfaces(scene));
  try {
    for (const end of arc) expect(checker.check([{ ...end, time: 0 }, { ...end, time: 1 }], pivot, 0.2, "target").status).toBe("clear");
    const result = checker.check(arc, pivot, 0.2, "target");
    expect(result.status).toBe("blocked"); expect(result.visibility).toBe("sampled");
    expect(result.issues.some(issue => issue.kind === "occluded")).toBe(true);
    expect(result.issues.some(issue => issue.kind === "collision")).toBe(false);
    expect(checker.check(arc, pivot, 0.2, "missing").status).toBe("blocked");
  } finally { checker.free(); for (const m of [target, occluder]) { m.geometry.dispose(); m.material.dispose(); } }
});
it("keeps a visibility pass distinct from unsupported or absent targets", async () => {
  const scene = new Scene(), target = mesh(scene, "target", 0, 0, 1, 1), window = mesh(scene, "window", 0, 2.5, 1, 0.1);
  window.material.transparent = true;
  const checker = await createCameraPathChecker([], cameraCollisionSurfaces(scene));
  try { expect(checker.check(arc, pivot, 0.2, "target").status).toBe("clear"); }
  finally { checker.free(); for (const m of [target, window]) { m.geometry.dispose(); m.material.dispose(); } }
});
