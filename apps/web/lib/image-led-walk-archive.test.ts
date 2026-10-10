// @vitest-environment node
import { expect, it } from "vitest";
import sharp from "sharp";
import type { Document } from "mongodb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionVideoToolsAvailable, silentMotionVideo } from "./motion-video";
import { archiveHash, readWorldArchive, type WorldArchive } from "./world-import-archive";
import { buildWorldZip } from "./export-build";
import { downloadImageLedWalkArchive, imageLedWalkReceipt, importWorldImageLedWalks } from "./image-led-walk-archive";
import { prepareWorldImport } from "./world-import-content";
import { IMAGE_LED_MAP_FRAME, IMAGE_LED_WALK_PROFILE, type ImageLedWalkDoc, type ImageLedPlayback } from "./image-led-walk";

import { prepareImageLedPlayback } from "./image-led-walk-playback";

async function fixture(clip?: { original: Buffer; silent: Buffer; media: Awaited<ReturnType<typeof silentMotionVideo>>["media"] }, canvas?: ImageLedPlayback) {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#7257aa" } }).png().toBuffer();
  const sha256 = archiveHash(bytes), date = new Date(0), image = { key: "source/map.png", bytes: bytes.length, sha256, content_type: "image/png" as const, width: 64, height: 64 };
  const points = [{ x: .5, y: .9 }, { x: .5, y: .7 }];
  const walk: ImageLedWalkDoc = {
    _id: "source:walk", id: "walk", session_id: "source", profile: IMAGE_LED_WALK_PROFILE, created_at: date, updated_at: date,
    request_sha256: sha256, status: "needs_review", revision: 1, prompt: "Keep the book bay and moth sign",
    source: { node_id: "map", image_key: image.key, image, map_frame: { bounds: { x: 0, y: 0, w: 100, h: 100 }, parent_id: null }, source_projection: "illustrated_oblique_or_unknown", binding_sha256: sha256 },
    landmarks: [{ id: "bookshop", entity_id: "bookshop", label: "Bookshop", visual: "projecting book bay", source_rectangle: { left: 0, top: 0, width: 64, height: 64 }, reference_kind: "owner_reviewed_crop", image }],
    route: { frame: IMAGE_LED_MAP_FRAME, points, map_sha256: sha256, sha256: archiveHash(JSON.stringify({ frame: IMAGE_LED_MAP_FRAME, points, map_sha256: sha256 })) },
    frames: [{ index: 0, status: "ready", job_id: "private-job", raw: image, image, review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256, reviewed_at: date.toISOString() } },
      { index: 1, status: "submission_unknown", job_id: "ambiguous-provider-job", review: { identity: "pending", route: "pending", spatial: "unmeasured" } }],
    legs: [{ index: 0, from: 0, to: 1, status: "empty", review: { temporal: "pending" } }],
  };
  const mediaBytes = new Map([[image.key, bytes]]);
  if (canvas) {
    const playback = await prepareImageLedPlayback(bytes, canvas), sha256 = archiveHash(playback);
    walk.frames[0]!.image = { key: "source/playback.jpg", bytes: playback.length, sha256, content_type: "image/jpeg", width: canvas.width, height: canvas.height };
    walk.frames[0]!.derivative = { kind: "contain-jpeg-v1", source_sha256: image.sha256, crop: false, stretch: false, canvas };
    walk.frames[0]!.review.sha256 = sha256; mediaBytes.set("source/playback.jpg", playback);
  }
  if (clip) {
    const original = { key: "source/original.mp4", bytes: clip.original.length, sha256: archiveHash(clip.original), content_type: "video/mp4" as const };
    const video = { key: "source/silent.mp4", bytes: clip.silent.length, sha256: archiveHash(clip.silent), content_type: "video/mp4" as const };
    walk.legs[0] = { ...walk.legs[0]!, status: "ready", original, video, media: clip.media };
    mediaBytes.set(original.key, clip.original); mediaBytes.set(video.key, clip.silent);
  }
  const receipt = imageLedWalkReceipt(walk), exported = await downloadImageLedWalkArchive([receipt], async key => ({ bytes: mediaBytes.get(key)! }));
  const zip = await buildWorldZip([{ id: "map", parent_id: null, title: "City", query: "City", created_at: date.toISOString(), relation: "root", scale_tier: "city", click_in_parent: null, scene_view: null, sources: [], bytes,
    content_type: "image/png", metadata: { image_key: image.key, image_model: "source", prompt_author_model: "planner", aspect_ratio: "1:1" } }],
  { session_id: "source", entities: [], bounds: { x: 0, y: 0, w: 100, h: 100 }, schema_version: 1, updated_at: date }, { entities: [] }, [], [], [], undefined, [], [], [], [],
  { session_id: "source", captured_at: date.toISOString(), visibility: "owner", scene_heads: [], entity_registry: null, workspace: { title: "Illustrated route" }, external_resources: [] }, undefined, undefined, exported);
  return { walk, receipt, bytes, exported, archive: await readWorldArchive(Buffer.from(zip)) };
}

it("exports originals, checkpoint origins and split reviews while stripping jobs and in-flight state", async () => {
  const f = await fixture();
  expect(f.exported.files).toHaveLength(1);
  expect(f.exported.files[0]!.data).toEqual(f.bytes);
  expect(f.receipt.frames[1]!.status).toBe("empty");
  expect(JSON.stringify(f.receipt)).not.toMatch(/private-job|ambiguous-provider-job|provider_request|work_token/);
  expect(f.archive.manifest.version).toBe(5);
  expect(f.archive.files.has("motion.json")).toBe(true); expect(f.archive.files.has("path-videos.json")).toBe(true);
});

it("restores an image-only world as inert history with remapped owned source bytes and independent reviews", async () => {
  const f = await fixture(), plan = await prepareWorldImport(f.archive, "destination"), restored = plan.records.image_led_walks![0]!;
  expect(plan.preview).toMatchObject({ pages: 1, places: 0, image_led_walks: 1 });
  expect(restored).toMatchObject({ status: "archived", session_id: "destination", archive_provenance: { source_session_id: "source", source_id: "walk", original_status: "needs_review" } });
  expect(restored.source.node_id).toBe(plan.records.nodes![0]!._id);
  expect(restored.source.image.key).toMatch(/^destination\/restored\//);
  expect(restored.frames[0].raw.sha256).toBe(f.walk.frames[0]!.raw!.sha256);
  expect(restored.frames[0].review).toMatchObject({ identity: "approved", route: "approved", spatial: "unmeasured" });
  expect(plan.records).not.toHaveProperty("image_led_walk_steps");
  expect(plan.records).not.toHaveProperty("spend_ledger");
});

async function changed(f: Awaited<ReturnType<typeof fixture>>, edit: (content: Record<string, unknown>) => void) {
  const content = structuredClone(f.archive.json("image-led-walks.json")) as Record<string, unknown>; edit(content);
  const archive: WorldArchive = { ...f.archive, json: name => name === "image-led-walks.json" ? content : f.archive.json(name) };
  return importWorldImageLedWalks(archive, "destination", {}, [], new Map([["map", "restored-map"]]));
}

it.each(["sha", "review", "execution", "inventory", "spatial", "route"])("rejects forged %s evidence with valid outer ZIP checksums", async kind => {
  const f = await fixture();
  await expect(changed(f, content => {
    const row = (content.receipts as Record<string, unknown>[])[0]!;
    const frames = row.frames as { image: { sha256: string }; review: { sha256: string; spatial: string } }[];
    if (kind === "sha") frames[0]!.image.sha256 = "0".repeat(64);
    if (kind === "review") frames[0]!.review.sha256 = "0".repeat(64);
    if (kind === "execution") row.work_token = "private-provider-lease";
    if (kind === "inventory") frames.pop();
    if (kind === "spatial") frames[0]!.review.spatial = "calibrated";
    if (kind === "route") (row.route as { points: { x: number; y: number }[] }).points[0]!.x = .7;
  })).rejects.toMatchObject({ status: 422 });
});

it("refuses corrupted stored bytes before producing a portable archive", async () => {
  const f = await fixture();
  await expect(downloadImageLedWalkArchive([f.receipt], async () => ({ bytes: Buffer.from("corrupt") }))).rejects.toMatchObject({ status: 503 });
});

it("refuses version-5 archives without their new content metadata", async () => {
  const f = await fixture(); f.archive.files.delete("image-led-walks.json");
  await expect(importWorldImageLedWalks(f.archive, "destination", {}, [], new Map())).rejects.toMatchObject({ status: 422 });
});

it("retains readable failed raw output as inert pending history without claiming a playable or approved still", async () => {
  const f = await fixture(), records: Record<string, Document[]> = {};
  const content = structuredClone(f.archive.json("image-led-walks.json")) as { receipts: { frames: { image?: unknown; status: string; review: unknown }[] }[] };
  const frame = content.receipts[0]!.frames[0]!;
  delete frame.image; frame.status = "empty"; frame.review = { identity: "pending", route: "pending", spatial: "unmeasured" };
  const archive: WorldArchive = { ...f.archive, json: name => name === "image-led-walks.json" ? content : f.archive.json(name) };
  await importWorldImageLedWalks(archive, "destination", records, [], new Map([["map", "restored-map"]]));
  expect(records.image_led_walks![0]!.frames[0]).toMatchObject({ status: "empty", raw: { sha256: archiveHash(f.bytes) }, review: { identity: "pending", route: "pending" } });
  expect(records.image_led_walks![0]!.frames[0]).not.toHaveProperty("image");
  expect(records.image_led_walks![0]!.status).toBe("archived");
});

const videoTools = await motionVideoToolsAvailable();
it.skipIf(!videoTools)("imports a short valid stream-copy clip and rejects an unrelated same-size, same-duration video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-led-archive-test-"));
  try {
    const generate = async (name: string, color: string) => {
      const path = join(directory, name);
      await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:size=128x96:rate=20`, "-t", "4.45", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
      return readFile(path);
    };
    const original = await generate("original.mp4", "blue"), valid = await silentMotionVideo(original);
    const f = await fixture({ original, silent: valid.bytes, media: valid.media });
    const plan = await prepareWorldImport(f.archive, "destination");
    expect(plan.records.image_led_walks![0]!.legs[0].media.duration).toBe(4.45);
    const unrelated = await generate("unrelated.mp4", "red");
    const bad = await fixture({ original, silent: unrelated, media: valid.media });
    await expect(prepareWorldImport(bad.archive, "destination")).rejects.toMatchObject({ status: 422 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20000);

const playbackCanvas: ImageLedPlayback = { kind: "contain-jpeg-v1", width: 128, height: 96, background: "#20231e" };
it("round-trips declared padding and retains the smaller native original", async () => {
  const f = await fixture(undefined, playbackCanvas), plan = await prepareWorldImport(f.archive, "destination");
  expect(plan.records.image_led_walks![0]!.frames[0]).toMatchObject({ raw: { width: 64, height: 64 }, image: { width: 128, height: 96 }, derivative: { kind: "contain-jpeg-v1", canvas: playbackCanvas } });
});
it("rejects a forged padding declaration despite valid original and playback checksums", async () => {
  const f = await fixture(undefined, playbackCanvas);
  await expect(changed(f, content => {
    const rows = content.receipts as { frames: { derivative: { canvas: ImageLedPlayback } }[] }[];
    rows[0]!.frames[0]!.derivative.canvas.width = 127;
  })).rejects.toMatchObject({ status: 422 });
});
