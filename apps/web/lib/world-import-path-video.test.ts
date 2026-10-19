// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { PerspectiveCamera } from "three";
import type { Document } from "mongodb";
import { emptyPlaceScene } from "./place-scene";
import { VIEW_PASSES, type PlaceViewExport } from "./place-view";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import { illustrationDependency } from "./illustration-input";
import { wirePlaceView } from "./place-view-server";
import { downloadPathVideoArchive, inertPathVideoReceipt, pathVideoReceipt } from "./path-video-archive";
import { buildWorldZip } from "./export-build";
import { archiveHash, readWorldArchive, type WorldArchive } from "./world-import-archive";
import { prepareWorldImport } from "./world-import-content";
import { importWorldPathVideos } from "./world-import-path-video";
import { motionVideoToolsAvailable } from "./motion-video";
import type { PathVideoDoc } from "./path-video";
import type { MotionStudyDoc } from "./motion-study";
// These tests run real ffmpeg or sharp. Several take 1 to 3.4 s on Linux, and in a gVisor
// sandbox or with two sandboxes on one host they pass the 5 s vitest default. So every test
// in this file gets 20 s, from the describe below. vi.setConfig would not hold: with vitest
// isolation off it only applies in the first test file that a worker runs.

async function fixture(accepted = false, count = 2, route = false) {
  const date = new Date(0).toISOString(), definition = emptyPlaceScene(), scene = { id: "scene", session_id: "source", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, definition, updated_at: date };
  const width = accepted ? 688 : 64, height = accepted ? 384 : 32;
  const bytes = await sharp({ create: { width, height, channels: 4, background: "#506070" } }).png().toBuffer();
  const file = { key: "source/view.png", sha256: archiveHash(bytes), bytes: bytes.length }, camera = new PerspectiveCamera(60, width / height, .05, 400);
  camera.position.set(0, .82, 0); camera.updateMatrixWorld();
  const views: PlaceViewDoc[] = Array.from({ length: count }, (_, i) => i < 2 ? ["a", "b"][i]! : `v${i}`).map((id, index) => { const matrix = camera.matrixWorld.toArray(); matrix[14] = -4 * index;
    return { _id: `source:${id}`, id, session_id: "source", label: `Checkpoint ${index + 1}`, created_at: date, root_place_id: "place", version: 1, mode: "walk", width, height,
      floor_id: null, camera: { projection: "perspective", near: .05, far: 400, world_matrix: matrix, projection_matrix: camera.projectionMatrix.toArray() },
      depth: { encoding: "linear_view_z_8bit_near_white", near: .05, far: 400 }, normals: "view_space_rgb", surface_policy: "opaque_geometry", objects: [], assets: [],
      sources: [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition_sha256: viewHash(definition) }],
      files: Object.fromEntries(VIEW_PASSES.map(pass => [pass, file])) as PlaceViewDoc["files"], provenance: "client_rendered_saved_geometry", request_sha256: archiveHash(id), ...(!accepted ? { walk_checkpoint: true as const } : {}) };
  });
  const job: PathVideoDoc = { _id: "source:walk", id: "walk", session_id: "source", place_id: "place", view_ids: ["a", "b"], views_sha256: viewHash(views.map(illustrationDependency)),
    request_sha256: "a".repeat(64), created_at: new Date(0), status: "needs_review", prompt: "Synthetic contract fixture", reservation: 1, committed: .5, ledger_ids: ["secret-ledger"],
    keyframe_reservation: .1, keyframe_parameters: {}, duration: 1, subject: null, art: file, work_token: "secret-work-claim", verification_version: 2,
    keyframes: [{ frame: 0, time: 0, stage: "source", file }, { frame: 1, time: 1, stage: "chain", file, attempt: { token: "secret-provider-claim", status: "ready", cost: .1, request_id: "synthetic-only" },
      result: { gate: "failed", candidates: [], chosen: 0, passed: false, sky_pinned: true } }],
    legs: [{ seconds: 1, duration: 3, cost: .24, move: { orbit_deg: 0, turn_deg: 0, rise_m: 0, forward_m: 4, subject: null }, attempts: [] }], error: "Consistency retry failed" };
  const storage = new Map([[file.key, bytes]]), required = async (key: string) => ({ bytes: storage.get(key)! });
  if (accepted) {
    const original = await sharp(bytes).jpeg().toBuffer(), anchor = { key: "source/anchor.jpg", sha256: archiveHash(original), bytes: original.length };
    storage.set(anchor.key, original);
    const anchors = await Promise.all(views.map(async (_view, i) => {
      if (!route) return anchor;
      const image = await sharp({ create: { width, height, channels: 3, background: { r: 50 + i * 8, g: 90, b: 110 } } }).jpeg().toBuffer(), value = { key: `source/anchor-${i}.jpg`, sha256: archiveHash(image), bytes: image.length };
      storage.set(value.key, image); return value;
    }));
    job.view_ids = views.map(view => view.id);
    job.keyframes = views.map((_view, i) => ({ frame: i, time: Math.round(i / (count - 1) * 1e6) / 1e6, stage: "source", file: anchors[i]! }));
    job.duration = 5 * (count - 1); job.legs = views.slice(1).map(() => ({ ...job.legs[0]!, seconds: 5, duration: 5, cost: .4 })); job.retry_allowance = 0; job.keyframe_policy = route ? "accepted-route-v1" : "accepted-only-v1";
    if (route) { job.reservation = .4 * (count - 1); job.committed = 0; }
    job.accepted_anchors = views.map((view, i) => ({ view_id: view.id, asset_id: `anchor${i}`, sha256: anchors[i]!.sha256, bytes: anchors[i]!.bytes,
      input_sha256: illustrationDependency(view).input_sha256, camera_sha256: viewHash(view.camera), source_sha256: file.sha256, review_sha256: archiveHash(`review${i}`) }));
    job.accepted_anchors_sha256 = viewHash(job.accepted_anchors);
  }
  const cameraViews: PlaceViewExport[] = views.map(view => { const { _id: _id, session_id: _sid, files: _files, ...capture_metadata } = view;
    return { view: wirePlaceView(view, false), capture_metadata, passes: VIEW_PASSES.map(pass => ({ pass, sha256: file.sha256, bytes })) }; });
  async function archive() {
    const pathVideos = await downloadPathVideoArchive([pathVideoReceipt(job)!], [], views, required);
    return readWorldArchive(Buffer.from(await buildWorldZip([], { session_id: "source", entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, schema_version: 1, updated_at: date }, { entities: [] }, [], [scene], [], undefined, [], [], [], cameraViews,
      { session_id: "source", captured_at: date, visibility: "owner", scene_heads: [scene], entity_registry: null, workspace: { title: "Route world" }, external_resources: [] }, undefined, pathVideos)));
  }
  return { job, views, bytes, file, storage, archive };
}

describe("world import path video", { timeout: 20_000 }, () => {
  it("keeps accepted-only anchor policy and exact JPEG evidence inert and portable without reauthorizing generation", async () => {
    const f = await fixture(true), archive = await f.archive(), restored = (await prepareWorldImport(archive, "destination")).records.path_videos![0] as PathVideoDoc;
    expect(restored).toMatchObject({ status: "cancelled", keyframe_policy: "accepted-only-v1", retry_allowance: 0, accepted_anchors_sha256: f.job.accepted_anchors_sha256,
      accepted_anchors: f.job.accepted_anchors, reservation: 0, committed: 0, ledger_ids: [], archive_provenance: { source_session_id: "source" } });
    expect(restored.keyframes.map(frame => frame.file!.sha256)).toEqual(f.job.keyframes.map(frame => frame.file!.sha256));
    expect(restored.keyframes.every(frame => frame.file!.key.startsWith("destination/") && frame.stage === "source" && !frame.attempt)).toBe(true);
  });
  it.each([2, 3, 12])("roundtrips %i ordered accepted-route anchors as inert exact JPEGs with uniform five-second legs", async count => {
    const f = await fixture(true, count, true), plan = await prepareWorldImport(await f.archive(), "destination"), restored = plan.records.path_videos![0] as PathVideoDoc;
    expect(restored).toMatchObject({ status: "cancelled", keyframe_policy: "accepted-route-v1", retry_allowance: 0, duration: 5 * (count - 1), accepted_anchors_sha256: f.job.accepted_anchors_sha256,
      accepted_anchors: f.job.accepted_anchors, reservation: 0, committed: 0, ledger_ids: [], keyframe_reservation: 0, keyframe_parameters: {}, archive_provenance: { source_session_id: "source" } });
    expect(restored.legs).toHaveLength(count - 1); expect(restored.legs.every(leg => leg.seconds === 5 && leg.duration === 5 && leg.cost === .4 && !leg.attempts.length)).toBe(true);
    expect(restored.keyframes.map(frame => frame.file!.sha256)).toEqual(f.job.keyframes.map(frame => frame.file!.sha256));
    for (const [i, frame] of restored.keyframes.entries()) { const upload = plan.uploads.find(item => item.key === frame.file!.key)!;
      expect(upload.contentType).toBe("image/jpeg"); expect(upload.bytes).toEqual(f.storage.get(f.job.keyframes[i]!.file!.key)); expect(frame.stage).toBe("source"); expect(frame.attempt).toBeUndefined(); }
    expect(restored).not.toHaveProperty("work_token"); expect(restored).not.toHaveProperty("verification_version");
  });
  it.each(["missing-anchor", "anchor-order", "middle-camera", "middle-review", "frame-paint", "frame-time", "leg-duration", "leg-price", "leg-retry", "dropped", "total-duration", "overspend", "v1-substitution"])("rejects forged accepted-route archive %s", async change => {
    const f = await fixture(true, 3, true), archive = await f.archive(), json = archive.json, content = json("path-videos.json") as Document, receipt = content.receipts[0];
    if (change === "missing-anchor") receipt.accepted_anchors.splice(1, 1);
    if (change === "anchor-order") receipt.accepted_anchors.reverse();
    if (change === "middle-camera") receipt.accepted_anchors[1].camera_sha256 = "0".repeat(64);
    if (change === "middle-review") receipt.accepted_anchors[1].review_sha256 = "invalid";
    if (change === "frame-paint") receipt.keyframes[1].attempt = { status: "ready", cost: .1, request_id: "painted" };
    if (change === "frame-time") receipt.keyframes[1].time = .4;
    if (change === "leg-duration") receipt.legs[1].duration = 6;
    if (change === "leg-price") receipt.legs[1].cost = .41;
    if (change === "leg-retry") receipt.legs[1].attempts = [{ status: "failed", cost: .4 }, { status: "failed", cost: .4 }];
    if (change === "dropped") receipt.legs[1].dropped = true;
    if (change === "total-duration") receipt.duration = 5;
    if (change === "overspend") receipt.original_spend.reservation = .81;
    if (change === "v1-substitution") receipt.keyframe_policy = "accepted-only-v1";
    receipt.accepted_anchors_sha256 = viewHash(receipt.accepted_anchors); archive.json = path => path === "path-videos.json" ? content : json(path);
    await expect(prepareWorldImport(archive, "destination")).rejects.toThrow();
  });
  it("refuses PNG substitution and checkpoint cameras for the new reviewed route without changing v1", async () => {
    const f = await fixture(true, 3, true), anchor = f.job.accepted_anchors![1]!, frame = f.job.keyframes[1]!;
    const png = await sharp(f.storage.get(frame.file!.key)!).png().toBuffer(), updated = { ...frame.file!, bytes: png.length, sha256: archiveHash(png) };
    f.storage.set(updated.key, png); frame.file = updated; Object.assign(anchor, { sha256: updated.sha256, bytes: updated.bytes }); f.job.accepted_anchors_sha256 = viewHash(f.job.accepted_anchors);
    await expect(prepareWorldImport(await f.archive(), "destination")).rejects.toThrow(/encoding/);
    const g = await fixture(true, 3, true); g.views[1]!.walk_checkpoint = true; g.job.views_sha256 = viewHash(g.views.map(illustrationDependency));
    g.job.accepted_anchors![1]!.input_sha256 = illustrationDependency(g.views[1]!).input_sha256; g.job.accepted_anchors_sha256 = viewHash(g.job.accepted_anchors);
    await expect(g.archive()).rejects.toMatchObject({ status: 409 });
  });
  it("roundtrips original high-resolution map art separately from accepted-only camera-sized JPEG anchors", async () => {
    const f = await fixture(true), bytes = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: "#385122" } }).png().toBuffer();
    const art = { key: "source/original-map.png", sha256: archiveHash(bytes) };
    f.storage.set(art.key, bytes); f.job.art = art;
    for (const anchor of f.job.accepted_anchors!) anchor.source_sha256 = art.sha256;
    f.job.accepted_anchors_sha256 = viewHash(f.job.accepted_anchors);
    const plan = await prepareWorldImport(await f.archive(), "destination"), restored = plan.records.path_videos![0] as PathVideoDoc;
    expect(restored.art!.sha256).toBe(art.sha256); expect(plan.uploads.find(upload => upload.key === restored.art!.key)!.bytes).toEqual(bytes);
    expect(restored.accepted_anchors).toEqual(f.job.accepted_anchors); expect(restored.keyframes.every(frame => frame.file!.sha256 === f.job.keyframes[frame.frame]!.file!.sha256)).toBe(true);
  });
  it.each(["fingerprint", "camera", "frame", "retry", "policy"])("rejects forged accepted-only archive %s metadata", async change => {
    const f = await fixture(true), archive = await f.archive(), json = archive.json, content = json("path-videos.json") as Document;
    const receipt = content.receipts[0];
    if (change === "fingerprint") receipt.accepted_anchors_sha256 = "0".repeat(64);
    if (change === "camera") { receipt.accepted_anchors[1].camera_sha256 = "0".repeat(64); receipt.accepted_anchors_sha256 = viewHash(receipt.accepted_anchors); }
    if (change === "frame") { receipt.accepted_anchors[1].sha256 = "0".repeat(64); receipt.accepted_anchors_sha256 = viewHash(receipt.accepted_anchors); }
    if (change === "retry") receipt.retry_allowance = 1;
    if (change === "policy") delete receipt.keyframe_policy;
    archive.json = path => path === "path-videos.json" ? content : json(path);
    await expect(prepareWorldImport(archive, "destination")).rejects.toThrow();
  });

  it("round-trips paused walk checkpoints and exact completed bytes as inert provenance, without leases or spend", async () => {
    const f = await fixture(), archive = await f.archive(), plan = await prepareWorldImport(archive, "destination"), restored = plan.records.path_videos![0] as PathVideoDoc;
    expect(archive.manifest.version).toBe(4); expect(plan.preview).toMatchObject({ views: 2, path_videos: 1 });
    expect(restored).toMatchObject({ status: "cancelled", reservation: 0, committed: 0, ledger_ids: [], funding_released: true, archive_provenance: { source_session_id: "source", source_id: "walk", original_status: "needs_review", committed: .5 } });
    expect(restored.views_sha256).toBe(f.job.views_sha256); expect(plan.records.place_views!.every(view => view.walk_checkpoint === true)).toBe(true);
    expect(restored.keyframes[1]!.result).toEqual(f.job.keyframes[1]!.result);
    expect(plan.uploads.find(upload => upload.key === restored.keyframes[1]!.file!.key)!.bytes).toEqual(f.bytes);
    expect(restored.keyframes[1]!.file!.sha256).toBe(f.file.sha256);
    expect(JSON.stringify(archive.json("path-videos.json"))).not.toMatch(/secret-ledger|secret-work-claim|secret-provider-claim|verification_version/);
    expect(restored).not.toHaveProperty("work_token"); expect(restored).not.toHaveProperty("verification_version");
  });

  it("does not export active or unknown submissions and never fabricates an inert ready record", async () => {
    const f = await fixture();
    for (const status of ["scheduled", "running", "submission_unknown"] as const) expect(pathVideoReceipt({ ...f.job, status })).toBeNull();
    const receipt = pathVideoReceipt(f.job)!;
    expect(inertPathVideoReceipt(receipt, "fork").status).toBe("cancelled");
    f.job.status = "ready";
    await expect(f.archive()).rejects.toMatchObject({ status: 409 });
  });

  it.each(["source-hash", "file-hash", "active", "lease", "evidence-hash", "missing-file", "camera-purpose"])("rejects forged or incomplete archived walk %s", async kind => {
    const f = await fixture(), archive = await f.archive(), json = archive.json, content = json("path-videos.json") as Document;
    if (kind === "source-hash") content.receipts[0].views_sha256 = "0".repeat(64);
    if (kind === "file-hash") content.files[0].sha256 = "0".repeat(64);
    if (kind === "active") content.receipts[0].status = "running";
    if (kind === "lease") content.receipts[0].work_token = "claim";
    if (kind === "evidence-hash") content.receipts[0].keyframes[1].result.final_image = { sha256: "0".repeat(64) };
    if (kind === "missing-file") archive.files.delete(content.files[0].file);
    archive.json = path => path === "path-videos.json" ? content : kind === "camera-purpose" && path === "place-views.json"
      ? (json(path) as Document[]).map(view => ({ ...view, capture_metadata: { ...view.capture_metadata, purpose: "map" } })) : json(path);
    await expect(prepareWorldImport(archive, "destination")).rejects.toThrow();
  });

  it("preserves exact silent joined video bytes and verifies media locally before accepting an archive", async () => {
    expect(await motionVideoToolsAvailable()).toBe(true);
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "ofb-path-fixture-"));
    try {
      const file = join(directory, "synthetic.mp4");
      await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x32:r=24:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { timeout: 10000 });
      const bytes = await readFile(file), video = { key: "source/video.mp4", bytes: bytes.length, sha256: archiveHash(bytes) };
      f.storage.set(video.key, bytes); f.job.video = video; f.job.media = { width: 64, height: 32, duration: 1, audio_streams: 0, source_audio_streams: 0, derivative: "silent_streamcopy_v1" }; f.job.status = "ready";
      const archive = await f.archive(), result = await prepareWorldImport(archive, "destination"), restored = result.records.path_videos![0] as PathVideoDoc;
      expect(restored.status).toBe("ready"); expect(restored.video!.sha256).toBe(video.sha256); expect(result.uploads.find(upload => upload.key === restored.video!.key)!.bytes).toEqual(bytes);
      const json = archive.json, content = json("path-videos.json") as Document; content.receipts[0].media.width = 128;
      archive.json = path => path === "path-videos.json" ? content : json(path);
      await expect(prepareWorldImport(archive, "destination")).rejects.toThrow(/metadata differs/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves a completed reviewed route at its planned size and rejects a rehashed short replacement", async () => {
    const f = await fixture(true, 3, true), directory = await mkdtemp(join(tmpdir(), "ofb-reviewed-route-fixture-"));
    try {
      const makeClip = async (name: string, seconds: number) => {
        const file = join(directory, name);
        await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=688x384:r=24:d=${seconds}`, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { timeout: 10000 });
        return readFile(file);
      };
      const bytes = await makeClip("joined.mp4", 10), video = { key: "source/reviewed-route.mp4", bytes: bytes.length, sha256: archiveHash(bytes) };
      f.storage.set(video.key, bytes); f.job.video = video; f.job.media = { width: 688, height: 384, duration: 10, audio_streams: 0, source_audio_streams: 0, derivative: "silent_streamcopy_v1" }; f.job.status = "ready";
      const archive = await f.archive(), plan = await prepareWorldImport(archive, "destination"), restored = plan.records.path_videos![0] as PathVideoDoc;
      expect(restored.status).toBe("ready"); expect(restored.duration).toBe(10); expect(restored.video!.sha256).toBe(video.sha256);
      expect(plan.uploads.find(upload => upload.key === restored.video!.key)!.bytes).toEqual(bytes);
      const json = archive.json, content = json("path-videos.json") as Document, receipt = content.receipts[0];
      const short = await makeClip("short.mp4", 1), descriptor = content.files.find((file: Document) => file.key === video.key);
      archive.files.set(descriptor.file, short); Object.assign(descriptor, { bytes: short.length, sha256: archiveHash(short) });
      Object.assign(receipt.video, { bytes: short.length, sha256: archiveHash(short) }); receipt.media.duration = 1;
      archive.json = path => path === "path-videos.json" ? content : json(path);
      await expect(prepareWorldImport(archive, "destination")).rejects.toThrow(/anchor receipt/);
      f.job.media.width = 64; await expect(f.archive()).rejects.toThrow(/anchor receipt/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("remaps an archived camera path's immutable study binding while keeping completed image evidence", async () => {
    const f = await fixture(), archive = await f.archive(), sourceStudy = { id: "study", _id: "source:study", session_id: "source", preparation_sha256: "b".repeat(64), view_id: "a" } as MotionStudyDoc;
    const destinationStudy = { ...sourceStudy, _id: "destination:study", session_id: "destination" }, receipt = pathVideoReceipt(f.job)!;
    delete receipt.place_id; delete receipt.view_ids; delete receipt.views_sha256;
    receipt.study_id = "study"; receipt.study_sha256 = viewHash(sourceStudy); receipt.preparation_sha256 = sourceStudy.preparation_sha256;
    const json = archive.json, content = json("path-videos.json") as Document; content.receipts = [JSON.parse(JSON.stringify(receipt))];
    archive.json = path => path === "path-videos.json" ? content : path === "motion.json" ? { version: 1, studies: [sourceStudy] } : json(path);
    const records: Record<string, Document[]> = { place_views: f.views.map(view => ({ ...view, session_id: "destination" })), motion_studies: [destinationStudy] }, uploads: { key: string; bytes: Buffer; contentType: string }[] = [];
    await importWorldPathVideos(archive as WorldArchive, "destination", records, uploads);
    expect(records.path_videos![0]!.study_sha256).toBe(viewHash(destinationStudy));
    expect(records.path_videos![0]!.keyframes[1].file.sha256).toBe(f.file.sha256);
  });
});
