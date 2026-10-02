// @vitest-environment node
import { expect, it } from "vitest";
import type { Document } from "mongodb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import JSZip from "jszip";
import { PerspectiveCamera, Vector3 } from "three";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { orbitPosition } from "./camera-path";
import { prepareCameraMotion, H3_CAMERA_ADAPTER_V1 } from "./camera-motion";
import { measureMotionLandmarks } from "./camera-motion-reference";
import { VIEW_PASSES, objectMaskColor, type ViewCapture, type PlaceViewExport } from "./place-view";
import { wirePlaceView } from "./place-view-server";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import { downloadMotionArchive, type MotionArchiveSnapshot } from "./motion-archive";
import { buildWorldZip } from "./export-build";
import { archiveHash, readWorldArchive } from "./world-import-archive";
import { prepareWorldImport } from "./world-import-content";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionFile } from "./motion-job";
import { motionVideoToolsAvailable, silentMotionVideo } from "./motion-video";
import { motionComparisonPlan, evaluateMotionReview, type MotionReviewInput } from "./motion-comparison";

async function fixture(adapter?: typeof H3_CAMERA_ADAPTER_V1) {
  const definition = { ...emptyPlaceScene(), objects: [{ ...newComponent("building", 8, 10), id: "inn" }, { ...newComponent("well", 12, 15), id: "well" }, { ...newComponent("bench", 14, 12), id: "bench" }] };
  const date = new Date(0).toISOString(), scene = { id: "scene", place_id: "place", session_id: "source", revision: 1, source_node_id: null, source_image_key: null, updated_at: date, definition };
  const path = { version: 1 as const, duration: 6, time: 0, pivot: [8, definition.objects[0]!.height / 2, 10] as [number, number, number], target_id: "inn",
    keyframes: [{ time: 0, azimuth: 135, elevation: 40, distance: 18 }, { time: 1, azimuth: 150, elevation: 40, distance: 18 }] };
  const camera = new PerspectiveCamera(60, 128 / 96, .05, 400), pivot = new Vector3(...path.pivot);
  camera.position.copy(orbitPosition(pivot, path.keyframes[0]!)); camera.lookAt(pivot); camera.updateMatrixWorld();
  const capture: ViewCapture = { version: 1, mode: "orbit", width: 128, height: 96, floor_id: null, path,
    camera: { projection: "perspective", near: .05, far: 400, world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() },
    depth: { encoding: "linear_view_z_8bit_near_white", near: .05, far: 400 }, normals: "view_space_rgb", surface_policy: "opaque_geometry",
    sources: [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition }], objects: definition.objects.map(o => o.id).sort().map((object_id, i) => ({ object_id, rgb: objectMaskColor(i) })),
    passes: { render: "", depth: "", normals: "", objects: "" } };
  const bytes = await sharp({ create: { width: 128, height: 96, channels: 4, background: "#587a69" } }).png().toBuffer(), sha256 = archiveHash(bytes);
  const file = { key: "source/render.png", sha256, bytes: bytes.length }, files = Object.fromEntries(VIEW_PASSES.map(p => [p, file])) as PlaceViewDoc["files"];
  const { passes: _passes, sources: _sources, ...metadata } = capture;
  const view: PlaceViewDoc = { ...metadata, _id: "source:view", session_id: "source", id: "view", label: "Inn arc", created_at: date, root_place_id: "place", request_sha256: "a".repeat(64),
    sources: [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition_sha256: viewHash(definition) }], assets: [], files, provenance: "client_rendered_saved_geometry" };
  const preparation = prepareCameraMotion(capture, adapter), source = { view_id: view.id, view_input_sha256: view.request_sha256,
    image: { kind: "render", asset_id: null, sha256, width: view.width, height: view.height }, registration: "saved_camera_dependency_not_visual_attestation", sources: view.sources, assets: [] };
  const measurements = measureMotionLandmarks(await sharp(bytes).ensureAlpha().raw().toBuffer(), view.width, view.height, view.objects);
  const study: MotionStudyDoc = { _id: "source:study", id: "study", session_id: "source", view_id: view.id, label: "Arc reference", created_at: date, request_sha256: "b".repeat(64),
    preparation_sha256: viewHash({ motion: preparation, source }), status: "reference_only", provenance: "client_rendered_saved_geometry", preflight: "not_server_attested",
    client_preflight: { status: "clear", samples: 100, clearance: .3, visibility: "sampled", issues: [] }, preparation,
    source: { view: wirePlaceView(view, false), definitions: capture.sources, image: { ...file, asset_id: null } },
    frames: preparation.reference_cameras.map(c => ({ time: c.time, seconds: c.seconds, camera: { ...capture.camera, world_matrix: c.world_matrix }, measurements })), files: preparation.reference_cameras.map(() => files) };
  const { _id: _id, session_id: _sid, files: _files, ...capture_metadata } = view;
  const cameraView: PlaceViewExport = { view: wirePlaceView(view, false), capture_metadata, passes: VIEW_PASSES.map(pass => ({ pass, bytes, sha256 })) };
  const snapshot: MotionArchiveSnapshot = { studies: [study], assets: [], reviews: [], selections: [] };
  const storage = new Map<string, Buffer>([[file.key, bytes]]);
  const required = async (key: string, _label: string, expected: MotionFile) => {
    const data = storage.get(key)!; expect(archiveHash(data)).toBe(expected.sha256); return { bytes: data };
  };
  async function zip() {
    return Buffer.from(await buildWorldZip([], { session_id: "source", entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, schema_version: 1, updated_at: date }, { entities: [] }, [], [scene], [], undefined, [], [], [], [cameraView],
      { session_id: "source", captured_at: date, visibility: "owner", scene_heads: [scene], entity_registry: null, workspace: { title: "Inn world" }, external_resources: [] }, await downloadMotionArchive(snapshot, required)));
  }
  return { snapshot, zip, bytes, view, scene, storage };
}

it("round-trips actual PNGs, reference cameras and source bindings without jobs or model calls", async () => {
  const f = await fixture(), archive = await readWorldArchive(await f.zip()), plan = await prepareWorldImport(archive, "destination");
  expect(archive.manifest.version).toBe(2); expect(plan.preview).toMatchObject({ views: 1, motion_studies: 1, clips: 0 });
  const restored = plan.records.motion_studies![0] as MotionStudyDoc, original = f.snapshot.studies[0]!;
  expect(restored.preparation_sha256).toBe(original.preparation_sha256); expect(restored.frames).toEqual(original.frames);
  expect(restored.source.view).toEqual(original.source.view); expect(restored.source.image.sha256).toBe(archiveHash(f.bytes));
  expect(restored.source.image.key).toMatch(/^destination\/restored\//);
  expect(restored.restored_from).toMatchObject({ session_id: "source", study_id: "study", study_sha256: viewHash(original), provenance: "user_supplied_archive" });
  expect(new Set(plan.uploads.map(u => u.key)).size).toBe(1); expect(plan.uploads.every(u => u.bytes.equals(f.bytes))).toBe(true);
  expect(Object.keys(plan.records).some(key => /jobs|reservation|workers|owners/.test(key))).toBe(false);
});
it("still imports a study saved under the v1 camera adapter", async () => {
  const f = await fixture(H3_CAMERA_ADAPTER_V1), plan = await prepareWorldImport(await readWorldArchive(await f.zip()), "destination");
  const restored = plan.records.motion_studies![0] as MotionStudyDoc;
  expect(restored.preparation).toEqual(f.snapshot.studies[0]!.preparation);
  expect(restored.preparation.adapter).toBe(H3_CAMERA_ADAPTER_V1);
  expect(motionComparisonPlan(restored).version).toBe("visible-bounds-human-v1");
});
it("keeps historical reference geometry and missing client preflight without inventing current evidence", async () => {
  const f = await fixture(); delete f.snapshot.studies[0]!.client_preflight;
  const archive = await readWorldArchive(await f.zip()), original = archive.json;
  archive.json = path => path === "place-scenes.json" ? [...original(path) as object[], { ...f.scene, revision: 2, definition: { ...f.scene.definition, label: "Edited inn" } }]
    : path === "place-scene-heads.json" ? [{ ...f.scene, revision: 2, definition: { ...f.scene.definition, label: "Edited inn" } }] : original(path);
  const plan = await prepareWorldImport(archive, "destination");
  expect(plan.records.place_scenes![0]!.revision).toBe(2); expect(plan.records.motion_studies![0]!.source.definitions[0].revision).toBe(1);
  expect(plan.records.motion_studies![0]!.client_preflight).toBeNull();
});
it.each(["camera", "measurements", "preparation", "source", "image", "preflight", "duplicate", "missing-pass", "unknown-adapter"])("rejects checksummed but invalid motion %s", async kind => {
  const f = await fixture(), archive = await readWorldArchive(await f.zip()), oldJson = archive.json;
  const content = archiveObjectForTest(oldJson("motion.json")), study = content.studies[0]!;
  if (kind === "camera") study.frames[1].camera.world_matrix[12] += 1;
  if (kind === "measurements") study.frames[0].measurements.unknown_pixels += 1;
  if (kind === "preparation") study.preparation_sha256 = "0".repeat(64);
  if (kind === "source") study.source.definitions[0].revision = 2;
  if (kind === "image") study.source.image.sha256 = "0".repeat(64);
  if (kind === "preflight") study.client_preflight.samples = 0;
  if (kind === "duplicate") content.studies.push(study);
  if (kind === "missing-pass") delete study.files[0].objects;
  if (kind === "unknown-adapter") study.preparation.adapter = "unrecognized-adapter";
  archive.json = path => path === "motion.json" ? content : oldJson(path);
  await expect(prepareWorldImport(archive, "destination")).rejects.toThrow();
});
// These mutations intentionally model untrusted, schema-less archive input.
function archiveObjectForTest(value: unknown) { return value as { studies: Document[]; files: Document[] }; }
it("rejects a version-2 archive with omitted motion metadata", async () => {
  const f = await fixture(), archive = await readWorldArchive(await f.zip()); archive.files.delete("motion.json");
  await expect(prepareWorldImport(archive, "destination")).rejects.toThrow("motion.json");
});
it("records every motion binary in the ZIP inventory once, including its byte hash", async () => {
  const f = await fixture(), zip = await JSZip.loadAsync(await f.zip()), motion = JSON.parse(await zip.file("motion.json")!.async("string"));
  expect(motion.files).toHaveLength(1);
  const inventory = JSON.parse(await zip.file("manifest.json")!.async("string")).files;
  expect(inventory).toContainEqual({ path: motion.files[0].file, bytes: f.bytes.length, sha256: archiveHash(f.bytes) });
});
it.skipIf(!await motionVideoToolsAvailable())("round-trips exact synthetic video bytes and failed reviews; rejects forged bindings and acceptance", async () => {
  const f = await fixture(), dir = await mkdtemp(join(tmpdir(), "ofb-archive-video-test-"));
  try {
    const filename = join(dir, "clip.mp4");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", filename]);
    const original = await readFile(filename), silent = await silentMotionVideo(original), study = f.snapshot.studies[0]!;
    const file = (key: string, bytes: Buffer) => { f.storage.set(key, bytes); return { key, sha256: archiveHash(bytes), bytes: bytes.length }; };
    // Deliberately synthetic mask tracks, not a render-quality or H3 receipt.
    for (const [i, frame] of study.frames.entries()) {
      const rgba = Buffer.alloc(128 * 96 * 4);
      for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
      for (const [j, object] of f.view.objects.entries()) for (let y = 12 + 22 * j; y < 26 + 22 * j; y++) for (let x = 15 + 26 * j + 2 * i; x < 31 + 26 * j + 2 * i; x++) {
        const p = (y * 128 + x) * 4; rgba[p] = object.rgb[0]; rgba[p + 1] = object.rgb[1]; rgba[p + 2] = object.rgb[2];
      }
      const bytes = await sharp(rgba, { raw: { width: 128, height: 96, channels: 4 } }).png().toBuffer();
      study.files[i] = { ...study.files[i]!, objects: file(`source/mask-${i}.png`, bytes) };
      frame.measurements = measureMotionLandmarks(rgba, 128, 96, f.view.objects);
    }
    const plan = motionComparisonPlan(study); expect(plan.issues).toEqual([]);
    const asset = { _id: "source:clip", id: "clip", session_id: "source", study_id: study.id, study_sha256: viewHash(study), preparation_sha256: study.preparation_sha256,
      model: study.preparation.model, adapter: study.preparation.adapter, parameters: study.preparation.parameters, request_id: "synthetic-test-only", expanded_prompt: null,
      original: file("source/original.mp4", original), silent: file("source/silent.mp4", silent.bytes), media: silent.media, created_at: new Date(0), comparison: { plan, sha256: viewHash(plan) } };
    const review: MotionReviewInput = { observations: [], visual: { architecture: "fail", occlusion_order: "unreviewed", continuous_motion: "unreviewed" }, notes: "Synthetic test failure" };
    f.snapshot.assets.push(asset); f.snapshot.reviews.push({ _id: "source:review", id: "review", session_id: "source", study_id: study.id, asset_id: asset.id,
      request_sha256: "c".repeat(64), comparison_sha256: viewHash(plan), video_sha256: asset.silent.sha256, review, outcome: evaluateMotionReview(plan, review, asset.media), created_at: new Date(0) });
    const passing: MotionReviewInput = { observations: plan.frames.flatMap((frame, i) => plan.landmarks.map((landmark, j) => ({ frame: i, object_id: landmark.id, observed_seconds: frame.seconds, bounds: frame.bounds[j]! }))),
      visual: { architecture: "pass", occlusion_order: "pass", continuous_motion: "pass" }, notes: "Synthetic measurements, not live video quality evidence" };
    f.snapshot.reviews.push({ ...f.snapshot.reviews[0]!, _id: "source:passing", id: "passing", review: passing, outcome: evaluateMotionReview(plan, passing, asset.media) });
    expect(f.snapshot.reviews[1]!.outcome.status).toBe("pass");
    f.snapshot.selections.push({ _id: "source:study", asset_id: "clip", review_id: "passing" });
    const archive = await readWorldArchive(await f.zip()), result = await prepareWorldImport(archive, "destination"), restored = result.records.motion_assets![0]!;
    expect(result.preview).toMatchObject({ motion_studies: 1, clips: 1 }); expect(restored.study_sha256).toBe(viewHash(result.records.motion_studies![0]));
    expect(restored.silent.sha256).toBe(asset.silent.sha256); expect(restored.original.sha256).toBe(asset.original.sha256);
    expect(restored.request_id).toBe("synthetic-test-only"); expect(result.records.motion_reviews![0]!.outcome.status).toBe("fail");
    expect(result.records.motion_selections).toEqual([{ _id: "destination:study", asset_id: "clip", review_id: "passing" }]);
    expect(result.uploads.find(u => u.key === restored.silent.key)!.bytes).toEqual(silent.bytes);
    const oldJson = archive.json;
    for (const kind of ["study-hash", "parameters", "outcome", "selection", "unreviewed-selection"]) {
      const content = oldJson("motion.json") as Document;
      if (kind === "study-hash") content.assets[0].study_sha256 = "0".repeat(64);
      if (kind === "parameters") content.assets[0].parameters.duration = 7;
      if (kind === "outcome") content.reviews[0].outcome.status = "pass";
      if (kind === "selection") content.selections = [{ _id: "source:study", asset_id: "clip", review_id: "review" }];
      if (kind === "unreviewed-selection") content.selections = [{ _id: "source:study", asset_id: "clip" }];
      archive.json = path => path === "motion.json" ? content : oldJson(path);
      await expect(prepareWorldImport(archive, "destination")).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
