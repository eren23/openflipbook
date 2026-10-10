// @vitest-environment node
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import type * as CreatorModule from "./creator";
import type * as IllustrationInputModule from "./illustration-input";
import type * as PlaceViewStoreModule from "./place-view-store";
const mocks = vi.hoisted(() => ({ requireCreator: vi.fn(), transaction: vi.fn(), source: vi.fn(), prepare: vi.fn(), art: vi.fn(), passes: vi.fn(), fence: vi.fn(), upload: vi.fn(), stored: vi.fn() }));
vi.mock("./creator", async () => ({ ...await vi.importActual<typeof CreatorModule>("./creator"), requireCreator: mocks.requireCreator }));
vi.mock("./db", () => ({ withDbTransaction: mocks.transaction }));
vi.mock("./r2", () => ({ getStoredBytes: mocks.stored, uploadJpeg: mocks.upload }));
vi.mock("./illustration-input", async () => ({ ...await vi.importActual<typeof IllustrationInputModule>("./illustration-input"), illustrationSource: mocks.source, prepareKeyframeViewInput: mocks.prepare, keyframeArt: mocks.art, keyframeViewPasses: mocks.passes }));
vi.mock("./place-view-store", async () => ({ ...await vi.importActual<typeof PlaceViewStoreModule>("./place-view-store"), fenceViewSources: mocks.fence }));
import { CreatorError } from "./creator-error";
import { illustrationDependency } from "./illustration-input";
import { importLocalIllustration, LOCAL_ILLUSTRATION_MODEL, LOCAL_IMAGE_LIMIT } from "./illustration-local-import";
import { verifiedKeyframe } from "./illustration-verification";
import { viewHash, type PlaceViewDoc } from "./place-view-store";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const id = "12233445-6677-4889-9aab-ccddeeff0011";
let view: PlaceViewDoc, image: Buffer, prepared: Record<string, unknown>, input: Record<string, unknown>, evidence: Record<string, unknown>;
let rows: Map<string, Map<string, Record<string, unknown>>>, blobs: Map<string, { bytes: Buffer; contentType: string }>;
const scopeRows = (name: string) => { const existing = rows.get(name); if (existing) return existing; const map = new Map<string, Record<string, unknown>>(); rows.set(name, map); return map; };
beforeEach(async () => {
  vi.resetAllMocks(); rows = new Map(); blobs = new Map();
  const png = await sharp({ create: { width: 688, height: 384, channels: 3, background: "#334455" } }).png().toBuffer();
  image = await sharp({ create: { width: 688, height: 384, channels: 3, background: "#bd6c3c" } }).jpeg().toBuffer();
  view = { version: 1, normals: "view_space_rgb", surface_policy: "opaque_geometry", provenance: "client_rendered_saved_geometry", _id: "world:view", session_id: "world", id: "view", root_place_id: "place", width: 688, height: 384, mode: "walk", floor_id: null, label: "Street camera", created_at: new Date().toISOString(), request_sha256: hash(Buffer.from("request")),
    camera: { projection: "perspective", near: .05, far: 400, world_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 24, 1.6, 43, 1], projection_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -.1, 0] }, depth: { encoding: "linear_view_z_8bit_near_white", near: .05, far: 43 },
    objects: [{ object_id: "building", rgb: [51, 68, 85] }], sources: [{ scene_id: "scene", place_id: "place", revision: 3, definition_sha256: hash(Buffer.from("definition")), x: 0, z: 0 }], assets: [],
    files: Object.fromEntries(["render", "depth", "normals", "objects"].map(pass => [pass, { key: `world/${pass}.png`, sha256: hash(png), bytes: png.length }])) as PlaceViewDoc["files"] } as PlaceViewDoc;
  scopeRows("place_views").set(view._id, view as unknown as Record<string, unknown>);
  scopeRows("place_scenes").set("world:place", { _id: "world:place", session_id: "world", source_image_key: "world/art.jpg" });
  const db = { collection(name: string) { return {
    async findOne(query: Record<string, unknown>) { const doc = scopeRows(name).get(query._id as string); return doc && (!query.session_id || doc.session_id === query.session_id) ? doc : null; },
    async countDocuments(query: Record<string, unknown>) { return [...scopeRows(name).values()].filter(doc => (!query.session_id || doc.session_id === query.session_id)
      && (!query.created_at || doc.created_at instanceof Date && doc.created_at >= (query.created_at as { $gte: Date }).$gte)
      && (!query["view_dependency.view_id"] || (doc.view_dependency as { view_id?: string } | undefined)?.view_id === query["view_dependency.view_id"])
      && (!query.$or || doc.region_edit || doc.geometry_refresh)).length; },
    async insertOne(doc: Record<string, unknown>) { scopeRows(name).set(doc._id as string, doc); },
    async updateOne(query: Record<string, unknown>, update: { $set: Record<string, unknown> }) { Object.assign(scopeRows(name).get(query._id as string)!, update.$set); return { matchedCount: 1 }; },
  }; } } as unknown as Db;
  mocks.requireCreator.mockResolvedValue(db); mocks.transaction.mockImplementation(run => run(db, {})); mocks.source.mockResolvedValue(view);
  mocks.art.mockResolvedValue({ key: "world/art.jpg", sha256: hash(Buffer.from("source")) });
  prepared = { gate_object_id: "building", gate_subject: { object_id: "building", kind: "building", label: "Bookshop" }, reference_preparation: { version: "source-art-map-landmarks-v1", source_sha256: hash(Buffer.from("source")), sha256: hash(Buffer.from("prepared")), source_width: 2048, source_height: 1152, width: 1024, height: 576, tile_size: 0, gutter: 0, crops: [], landmarks: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }], structural_guidance: { version: "saved-camera-controlnet-v1" } } };
  mocks.prepare.mockResolvedValue(prepared); mocks.passes.mockResolvedValue({ view, render: png, depth: png, objects: png });
  mocks.stored.mockImplementation(async key => blobs.get(key) ?? null);
  mocks.upload.mockImplementation(async (key: string, bytes: Buffer, contentType: string) => { blobs.set(key, { bytes: Buffer.from(bytes), contentType }); });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider or network call is permitted in this import test"); }));
  evidence = { version: 1, kind: LOCAL_ILLUSTRATION_MODEL, view_id: view.id, input_sha256: illustrationDependency(view).input_sha256, camera_sha256: viewHash(view.camera), scene_id: "scene", scene_revision: 3, definition_sha256: view.sources[0]!.definition_sha256, source_sha256: hash(Buffer.from("source")), image_sha256: hash(image), pass_sha256: Object.fromEntries(Object.entries(view.files).map(([pass, file]) => [pass, file.sha256])), origin: { producer: "private experiment", gate: "untrusted external claim ignored" } };
  rebuild();
});
function rebuild(bytes = image) { const receipt = JSON.stringify(evidence); input = { id, image_data_url: `data:image/${bytes[0] === 137 ? "png" : "jpeg"};base64,${bytes.toString("base64")}`, image_sha256: hash(bytes), receipt_json: receipt, receipt_sha256: hash(Buffer.from(receipt)) }; }

it("stores the exact JPEG and server-bound source draft, without gate/approval/provider eligibility", async () => {
  const result = await importLocalIllustration("world", "view", input);
  expect(result).toMatchObject({ model: LOCAL_ILLUSTRATION_MODEL, sha256: hash(image), accepted: false, gate: "unmeasured", normalization: { method: "none" }, keyframe: { gate: "unmeasured", passed: false, final_image: { sha256: hash(image) } } });
  expect(result.keyframe).not.toHaveProperty("content_approval"); expect(verifiedKeyframe(result.keyframe, result.sha256)).toBe(false);
  expect(mocks.prepare.mock.calls[0]![3]).toMatchObject({ stage: "first", art: "art", reference_profile: "source-art-map-landmarks-v1", reference_guidance: "saved-camera-controlnet-v1", gate_object_id: null });
  expect(scopeRows("illustration_jobs").size).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(view.accepted_illustration_id).toBeUndefined();
});
it("retains the original PNG separately and declares the final JPEG conversion/hash", async () => {
  const png = await sharp(image).png().toBuffer(); evidence.image_sha256 = hash(png); rebuild(png);
  const result = await importLocalIllustration("world", "view", input);
  expect(blobs.get(result.raw.key)!.bytes).toEqual(png); expect(result.raw.sha256).toBe(hash(png));
  expect(result.normalization).toMatchObject({ method: "png_to_srgb_jpeg_v1", raw_sha256: hash(png) }); expect(result.sha256).not.toBe(hash(png));
  const asset = scopeRows("illustration_assets").get(`world:local_${id}`)!;
  expect((await sharp(blobs.get(asset.key as string)!.bytes).metadata()).format).toBe("jpeg");
});
it("returns the same asset on an exact repeat, rejects differing receipts, and verifies stored exact bytes", async () => {
  const first = await importLocalIllustration("world", "view", input), uploads = mocks.upload.mock.calls.length;
  expect((await importLocalIllustration("world", "view", input)).id).toBe(first.id); expect(mocks.upload).toHaveBeenCalledTimes(uploads);
  evidence.origin = { producer: "different receipt" }; rebuild();
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 });
  evidence.origin = { producer: "private experiment", gate: "untrusted external claim ignored" }; rebuild();
  const corrupt = blobs.get(first.raw.key)!.bytes; corrupt[0] = corrupt[0]! ^ 1;
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 503 });
});
it("recovers the same free import after a storage acknowledgement failure without adding a second claim", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("Storage acknowledgement lost"));
  await expect(importLocalIllustration("world", "view", input)).rejects.toThrow("Storage acknowledgement lost");
  expect(scopeRows("illustration_local_imports").size).toBe(1); expect(scopeRows("illustration_assets").size).toBe(0);
  await importLocalIllustration("world", "view", input);
  expect(scopeRows("illustration_local_imports").size).toBe(1); expect(scopeRows("illustration_assets").size).toBe(1); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("rejects nonowners before reading source files or writing storage", async () => {
  mocks.requireCreator.mockRejectedValue(new CreatorError("Not owned", 403));
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 403 });
  expect(mocks.art).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
});
it("rejects stale scenes, foreign source/definition/pass hashes and client gate assertions", async () => {
  mocks.source.mockRejectedValueOnce(new CreatorError("Source changed", 409));
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 });
  for (const field of ["source_sha256", "definition_sha256", "input_sha256"] as const) {
    const original = evidence[field]; evidence[field] = "0".repeat(64); rebuild();
    await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 }); evidence[field] = original;
  }
  evidence.pass_sha256 = { ...(evidence.pass_sha256 as object), depth: "0".repeat(64) }; rebuild();
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 });
  await expect(importLocalIllustration("world", "view", { ...input, gate: "passed", accepted: true })).rejects.toMatchObject({ status: 400 });
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("rejects image/receipt hash changes, rotated or differently sized images, and checkpoint views", async () => {
  await expect(importLocalIllustration("world", "view", { ...input, image_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 400 });
  await expect(importLocalIllustration("world", "view", { ...input, receipt_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 400 });
  const wrong = await sharp({ create: { width: 1376, height: 768, channels: 3, background: "#556677" } }).jpeg().toBuffer(); evidence.image_sha256 = hash(wrong); rebuild(wrong);
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 400 });
  const rotated = await sharp(image).withMetadata({ orientation: 6 }).jpeg().toBuffer(); evidence.image_sha256 = hash(rotated); rebuild(rotated);
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 400 });
  view.walk_checkpoint = true;
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 }); expect(mocks.upload).not.toHaveBeenCalled();
});
it("bounds raw bytes and receipts before preparing source files or uploading", async () => {
  const oversized = Buffer.alloc(LOCAL_IMAGE_LIMIT + 1); evidence.image_sha256 = hash(oversized); rebuild(oversized);
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 400 });
  rebuild(); input.receipt_json = "x".repeat(256 * 1024 + 1); input.receipt_sha256 = hash(Buffer.from(input.receipt_json as string));
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 413 });
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
});
it("enforces the durable free-import rate before upload while allowing exact recovery", async () => {
  const first = await importLocalIllustration("world", "view", input), uploads = mocks.upload.mock.calls.length;
  for (let i = 0; i < 9; i++) scopeRows("illustration_local_imports").set(`world:other${i}`, { _id: `world:other${i}`, session_id: "world", created_at: new Date() });
  expect((await importLocalIllustration("world", "view", input)).id).toBe(first.id);
  await expect(importLocalIllustration("world", "view", { ...input, id: "12233445-6677-4889-9aab-ccddeeff0012" })).rejects.toMatchObject({ status: 429 });
  expect(mocks.upload).toHaveBeenCalledTimes(uploads); expect(scopeRows("illustration_local_imports").size).toBe(10);
});
it("keeps a subject-free imported draft unmeasured even when painting-only measurement would pass", async () => {
  prepared.gate_object_id = null; prepared.gate_subject = null;
  const result = await importLocalIllustration("world", "view", input);
  expect(result.keyframe).toMatchObject({ object_id: null, gate: "unmeasured", passed: false });
  expect(result.keyframe?.candidates.every(candidate => !candidate.passed)).toBe(true);
  expect(verifiedKeyframe(result.keyframe, result.sha256)).toBe(false);
});
it("preserves the claim and raw uploads without publishing when source artwork changes mid-import", async () => {
  mocks.upload.mockImplementationOnce(async (key: string, bytes: Buffer, contentType: string) => {
    blobs.set(key, { bytes: Buffer.from(bytes), contentType });
    scopeRows("place_scenes").get("world:place")!.source_image_key = "world/replaced-art.jpg";
  });
  await expect(importLocalIllustration("world", "view", input)).rejects.toMatchObject({ status: 409 });
  expect(scopeRows("illustration_local_imports").size).toBe(1); expect(scopeRows("illustration_assets").size).toBe(0);
  expect(scopeRows("illustration_jobs").size).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
});
