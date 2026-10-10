// @vitest-environment node
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import type * as CreatorModule from "./creator";
import type * as InputModule from "./illustration-input";
import type * as ViewModule from "./place-view-store";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), transaction: vi.fn(), source: vi.fn(), prepare: vi.fn(), art: vi.fn(), passes: vi.fn(), fence: vi.fn(), upload: vi.fn(), stored: vi.fn(), backend: vi.fn(), reserve: vi.fn() }));
vi.mock("./creator", async () => ({ ...await vi.importActual<typeof CreatorModule>("./creator"), requireCreator: mocks.owner }));
vi.mock("./db", () => ({ withDbTransaction: mocks.transaction }));
vi.mock("./r2", () => ({ getStoredBytes: mocks.stored, uploadJpeg: mocks.upload }));
vi.mock("./generation-reservation", () => ({ reserveGenerationSpend: mocks.reserve }));
vi.mock("./mesh-execution", () => ({ assetBackend: mocks.backend }));
vi.mock("./illustration-input", async () => ({ ...await vi.importActual<typeof InputModule>("./illustration-input"), illustrationSource: mocks.source, prepareKeyframeViewInput: mocks.prepare, keyframeArt: mocks.art, keyframeViewPasses: mocks.passes }));
vi.mock("./place-view-store", async () => ({ ...await vi.importActual<typeof ViewModule>("./place-view-store"), fenceViewSources: mocks.fence }));
import { CreatorError } from "./creator-error";
import { illustrationDependency } from "./illustration-input";
import { importLocalIllustration, LOCAL_ILLUSTRATION_MODEL } from "./illustration-local-import";
import { quoteLocalIllustrationVerification, verifyLocalIllustration } from "./illustration-local-verify";
import { LOCAL_VISUAL_SEGMENTATION_PROFILE, localVisualGeometry } from "./illustration-local-visual";
import { reviewedKeyframe, verifiedKeyframe } from "./illustration-verification";
import { viewHash, type PlaceViewDoc } from "./place-view-store";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const importId = "12233445-6677-4889-9aab-ccddeeff0011", verifyId = "12233445-6677-4889-9aab-ccddeeff0022";
let view: PlaceViewDoc, image: Buffer, mask: Buffer, prepared: Record<string, unknown>, imported: Awaited<ReturnType<typeof importLocalIllustration>>;
let rows: Map<string, Map<string, Record<string, unknown>>>, blobs: Map<string, { bytes: Buffer; contentType: string }>;
const docs = (name: string) => { const existing = rows.get(name); if (existing) return existing; const result = new Map<string, Record<string, unknown>>(); rows.set(name, result); return result; };
function matches(doc: Record<string, unknown>, query: Record<string, unknown>) { return Object.entries(query).every(([key, value]) => key === "created_at" ? doc.created_at instanceof Date && doc.created_at >= (value as { $gte: Date }).$gte
  : key === "view_dependency.view_id" ? (doc.view_dependency as { view_id?: string } | undefined)?.view_id === value : key === "$or" ? !!(doc.region_edit || doc.geometry_refresh) : doc[key] === value); }
beforeEach(async () => {
  vi.resetAllMocks(); rows = new Map(); blobs = new Map(); vi.stubEnv("MODAL_API_URL", "http://localhost:9999");
  const png = await sharp({ create: { width: 688, height: 384, channels: 3, background: "#334455" } }).png().toBuffer();
  mask = await sharp({ create: { width: 688, height: 384, channels: 3, background: "white" } }).png().toBuffer();
  image = await sharp({ create: { width: 688, height: 384, channels: 3, background: "#bd6c3c" } }).jpeg().toBuffer();
  view = { version: 1, normals: "view_space_rgb", surface_policy: "opaque_geometry", provenance: "client_rendered_saved_geometry", _id: "world:view", session_id: "world", id: "view", root_place_id: "place", width: 688, height: 384, mode: "walk", floor_id: null, label: "Street camera", created_at: new Date().toISOString(), request_sha256: hash(Buffer.from("request")),
    camera: { projection: "perspective", near: .05, far: 400, world_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 24, 1.6, 43, 1], projection_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -.1, 0] }, depth: { encoding: "linear_view_z_8bit_near_white", near: .05, far: 43 },
    objects: [{ object_id: "building", rgb: [51, 68, 85] }], sources: [{ scene_id: "scene", place_id: "place", revision: 3, definition_sha256: hash(Buffer.from("definition")), x: 0, z: 0 }], assets: [],
    files: Object.fromEntries(["render", "depth", "normals", "objects"].map(pass => [pass, { key: `world/${pass}.png`, sha256: hash(png), bytes: png.length }])) as PlaceViewDoc["files"] } as PlaceViewDoc;
  docs("place_views").set(view._id, view as unknown as Record<string, unknown>);
  docs("place_scenes").set("world:place", { _id: "world:place", session_id: "world", revision: 3, source_image_key: "world/art.jpg" });
  const db = { collection(name: string) { return {
    async findOne(query: Record<string, unknown>) { const doc = [...docs(name).values()].find(doc => matches(doc, query)); return doc ? structuredClone(doc) : null; },
    async countDocuments(query: Record<string, unknown>) { return [...docs(name).values()].filter(doc => matches(doc, query)).length; },
    async insertOne(doc: Record<string, unknown>) { if (docs(name).has(doc._id as string)) throw new Error("Duplicate key"); docs(name).set(doc._id as string, structuredClone(doc)); },
    async updateOne(query: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }) { const doc = [...docs(name).values()].find(doc => matches(doc, query)); if (!doc) return { matchedCount: 0 };
      Object.assign(doc, structuredClone(update.$set ?? {})); for (const [key, amount] of Object.entries(update.$inc ?? {})) doc[key] = (Number(doc[key]) || 0) + amount; return { matchedCount: 1 }; },
  }; } } as unknown as Db;
  mocks.owner.mockResolvedValue(db); mocks.transaction.mockImplementation(async run => { const old = structuredClone(rows); try { return await run(db, {}); } catch (error) { rows = old; throw error; } }); mocks.source.mockImplementation(async () => structuredClone(docs("place_views").get(view._id)));
  mocks.art.mockResolvedValue({ key: "world/art.jpg", sha256: hash(Buffer.from("source")) });
  const landmarks = ["A", "B", "C", "D"].map((label, i) => ({ label, left: i * 100, top: 10, width: 80, height: 80 }));
  prepared = { gate_object_id: "building", gate_subject: { object_id: "building", kind: "building", label: "building" }, reference_preparation: { version: "source-art-map-landmarks-v1", source_sha256: hash(Buffer.from("source")), sha256: hash(Buffer.from("prepared")), source_width: 2048, source_height: 1152, width: 1024, height: 576, tile_size: 0, gutter: 0, crops: [], landmarks, structural_guidance: { version: "saved-camera-controlnet-v1" } } };
  docs("source_landmark_references").set(`world:place:${hash(Buffer.from("source"))}`, { _id: `world:place:${hash(Buffer.from("source"))}`, session_id: "world", place_id: "place", source_sha256: hash(Buffer.from("source")), source_width: 2048, source_height: 1152, landmarks: structuredClone(landmarks), reviewed_at: new Date() });
  mocks.prepare.mockImplementation(async () => structuredClone(prepared)); mocks.passes.mockResolvedValue({ view, render: png, depth: png, objects: png });
  for (const file of Object.values(view.files)) blobs.set(file.key, { bytes: png, contentType: "image/png" });
  mocks.stored.mockImplementation(async key => blobs.get(key) ?? null);
  mocks.upload.mockImplementation(async (key: string, bytes: Buffer, contentType: string) => { blobs.set(key, { bytes: Buffer.from(bytes), contentType }); });
  mocks.reserve.mockResolvedValue(["day:date", "sess:world:date", "illustration:date"]);
  mocks.backend.mockImplementation(async () => { expect([...docs("illustration_local_verifications").values()][0]?.status).toBe("submitting"); expect(mocks.reserve).toHaveBeenCalledTimes(1); return { masks: [{ mask_png: mask.toString("base64"), request_id: "sam_request" }] }; });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No real network call permitted"); }));
  const receipt = JSON.stringify({ version: 1, kind: LOCAL_ILLUSTRATION_MODEL, view_id: view.id, input_sha256: illustrationDependency(view).input_sha256, camera_sha256: viewHash(view.camera), scene_id: "scene", scene_revision: 3, definition_sha256: view.sources[0]!.definition_sha256, source_sha256: hash(Buffer.from("source")), image_sha256: hash(image), pass_sha256: Object.fromEntries(Object.entries(view.files).map(([pass, file]) => [pass, file.sha256])), origin: { producer: "untrusted private experiment", passed: true } });
  imported = await importLocalIllustration("world", "view", { id: importId, image_data_url: `data:image/jpeg;base64,${image.toString("base64")}`, image_sha256: hash(image), receipt_json: receipt, receipt_sha256: hash(Buffer.from(receipt)) });
  mocks.upload.mockClear(); mocks.stored.mockClear(); mocks.prepare.mockClear(); mocks.art.mockClear();
});
async function request() { const result = await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256); return { id: verifyId, asset_id: imported.id, asset_sha256: imported.sha256, quote: result.quote }; }
async function visualRequest() {
  const colors: [number, number, number][] = [[51, 68, 85], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]], ids = ["building", "inn", "forge", "glass", "road"];
  const rectangles = [[0, 0, 160, 280], [180, 10, 220, 60], [500, 0, 680, 290], [380, 50, 460, 100]], pixels = Buffer.alloc(688 * 384 * 3), maskPixels = Buffer.alloc(688 * 384);
  for (let y = 0; y < 384; y++) for (let x = 0; x < 688; x++) {
    const i = rectangles.findIndex(([x0, y0, x1, y1]) => x >= x0! && x < x1! && y >= y0! && y < y1!); pixels.set(colors[i < 0 ? 4 : i]!, (y * 688 + x) * 3); if (i === 0) maskPixels[y * 688 + x] = 255;
  }
  const objects = await sharp(pixels, { raw: { width: 688, height: 384, channels: 3 } }).png().toBuffer();
  mask = await sharp(maskPixels, { raw: { width: 688, height: 384, channels: 1 } }).png().toBuffer();
  const definition = { objects: ids.map((id, i) => ({ id, label: i < 4 ? ["A", "B", "C", "D"][i]! : "Road", kind: i < 4 ? "building" : "path" })) };
  Object.assign(docs("place_scenes").get("world:place")!, { definition });
  view.sources[0]!.definition_sha256 = viewHash(definition); view.objects = ids.map((object_id, i) => ({ object_id, rgb: colors[i]! }));
  view.files.objects = { key: "world/objects.png", sha256: hash(objects), bytes: objects.length };
  docs("place_views").set(view._id, view as unknown as Record<string, unknown>); blobs.set(view.files.objects.key, { bytes: objects, contentType: "image/png" });
  const passes = await mocks.passes();
  mocks.passes.mockResolvedValue({ ...passes, view, objects });
  docs("illustration_assets").clear(); docs("illustration_local_imports").clear();
  const receipt = JSON.stringify({ version: 1, kind: LOCAL_ILLUSTRATION_MODEL, view_id: view.id, input_sha256: illustrationDependency(view).input_sha256, camera_sha256: viewHash(view.camera), scene_id: "scene", scene_revision: 3, definition_sha256: view.sources[0]!.definition_sha256, source_sha256: hash(Buffer.from("source")), image_sha256: hash(image), pass_sha256: Object.fromEntries(Object.entries(view.files).map(([pass, file]) => [pass, file.sha256])) });
  imported = await importLocalIllustration("world", "view", { id: importId, image_data_url: `data:image/jpeg;base64,${image.toString("base64")}`, image_sha256: hash(image), receipt_json: receipt, receipt_sha256: hash(Buffer.from(receipt)) });
  mocks.upload.mockClear(); mocks.reserve.mockClear();
  const selected = LOCAL_VISUAL_SEGMENTATION_PROFILE, quote = (await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256, selected)).quote;
  const expected = await localVisualGeometry(view, definition as Parameters<typeof localVisualGeometry>[1], ["A", "B", "C", "D"], "building", objects, image, [0, 0, 160, 280]);
  mocks.backend.mockImplementation(async () => ({ segmentation_profile: selected, masks: [{ mask_png: mask.toString("base64"), request_id: "sam_visual", visual_prompt_proof: expected.proof }] }));
  return { body: { id: verifyId, asset_id: imported.id, asset_sha256: imported.sha256, quote, segmentation_profile: selected }, expected, objects };
}

it("quotes without a charge and measures the exact imported JPEG once, preserving the unmeasured original", async () => {
  const body = await request(); expect(body.quote).toMatchObject({ reservation: .01, kind: "owner/local-keyframe-verification-v1" }); expect(mocks.backend).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  const result = await verifyLocalIllustration("world", "view", body);
  expect(mocks.backend.mock.calls[0]).toEqual(["illustration", "gate", { image_urls: [`data:image/jpeg;base64,${image.toString("base64")}`], box: [0, 0, 688, 384], width: 688, height: 384, label: "building" }, 200_000, 2_000_000]);
  expect(mocks.reserve.mock.calls[0]!.slice(2, 6)).toEqual(["world", "illustration", .01, "ILLUSTRATION_DAILY_CAP_USD"]);
  expect(result).toMatchObject({ accepted: false, verification: { status: "ready", reservation: .01 }, asset: { sha256: hash(image), model: LOCAL_ILLUSTRATION_MODEL, keyframe: { gate: "passed", passed: true, final_image: { sha256: hash(image), candidate_sha256: hash(image), method: "candidate" } } } });
  const asset = "asset" in result ? result.asset : undefined; expect(asset).toBeDefined(); expect(verifiedKeyframe(asset?.keyframe, asset?.sha256 ?? "")).toBe(true); expect(reviewedKeyframe(asset?.keyframe, asset?.sha256 ?? "")).toBe(false);
  expect(asset?.keyframe).not.toHaveProperty("content_approval"); expect(docs("illustration_assets").get(`world:${imported.id}`)!.keyframe).toMatchObject({ gate: "unmeasured", passed: false }); expect(view.accepted_illustration_id).toBeUndefined();
  expect(docs("illustration_jobs").size).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
  const derivative = [...docs("illustration_assets").values()].find(row => row.id !== imported.id)!;
  expect(blobs.get(derivative.key as string)!.bytes).toEqual(image); expect(derivative.parameters).toMatchObject({ verification: { source_asset_id: imported.id, gate_provider_submissions: 1, image_provider_submissions: 0, receipt: imported.receipt } });
  expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("ready"); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("refuses nonowners, foreign models and stale source/camera pins before storage reads or payment", async () => {
  mocks.owner.mockRejectedValueOnce(new CreatorError("Not owned", 403)); await expect(quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256)).rejects.toMatchObject({ status: 403 }); expect(mocks.stored).not.toHaveBeenCalled();
  const body = await request(); mocks.source.mockRejectedValueOnce(new CreatorError("Source changed", 409)); await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  docs("illustration_assets").get(`world:${imported.id}`)!.model = "fal-ai/fake"; await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  expect(mocks.backend).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
});
it("checks exact stored JPEG, raw receipt and all four passes before reserving", async () => {
  const body = await request(), key = `world/illustrations/${imported.id}/${imported.sha256}.jpg`, old = blobs.get(key)!;
  blobs.set(key, { ...old, bytes: Buffer.from("altered") }); await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 503 }); blobs.set(key, old);
  const normals = blobs.get(view.files.normals.key)!; blobs.set(view.files.normals.key, { ...normals, bytes: Buffer.from("bad normals") });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 503 });
  expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.backend).not.toHaveBeenCalled();
});
it("rejects stale landmark preparation, absent subjects, checkpoint views and altered quotes", async () => {
  const body = await request(); (prepared.reference_preparation as { landmarks: object[] }).landmarks = []; await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  (prepared.reference_preparation as { landmarks: object[] }).landmarks = ["A", "B", "C", "D"].map((label, i) => ({ label, left: i * 100, top: 10, width: 80, height: 80 }));
  prepared.gate_object_id = null; prepared.gate_subject = null; await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  prepared.gate_object_id = "building"; prepared.gate_subject = { object_id: "building", kind: "building", label: "building" };
  await expect(verifyLocalIllustration("world", "view", { ...body, quote: { ...body.quote, reservation: 0 } })).rejects.toMatchObject({ status: 409 });
  await expect(verifyLocalIllustration("world", "view", { ...body, gate: "passed", approved: true })).rejects.toMatchObject({ status: 400 });
  docs("place_views").get(view._id)!.walk_checkpoint = true; await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  expect(mocks.backend).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
});
it("retains a single unknown acknowledgement and never calls again for the same or a new UUID", async () => {
  const body = await request(); mocks.backend.mockRejectedValueOnce(new Error("Lost paid acknowledgement"));
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 503 });
  expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("submission_unknown");
  expect((await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256)).quote).toBeNull();
  await expect(verifyLocalIllustration("world", "view", { ...body, id: "12233445-6677-4889-9aab-ccddeeff0023" })).rejects.toMatchObject({ status: 409 });
  expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1); expect(docs("illustration_assets").size).toBe(1);
});
it("concurrent exact retries observe the durable marker and cannot segment twice", async () => {
  const body = await request(); let resolve!: (value: unknown) => void; mocks.backend.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = verifyLocalIllustration("world", "view", body); await vi.waitFor(() => expect(mocks.backend).toHaveBeenCalledTimes(1));
  expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("submitting");
  resolve({ masks: [{ mask_png: mask.toString("base64") }] }); expect((await first).verification.status).toBe("ready"); expect(mocks.backend).toHaveBeenCalledTimes(1);
});
it("recovers only free storage after a known acknowledgement, even after the quote expires", async () => {
  const body = await request(); mocks.upload.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toThrow("Storage unavailable"); expect([...docs("illustration_local_verifications").values()][0]!.status).toBe("measured");
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 20 * 60_000);
  try { expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("ready"); } finally { vi.useRealTimers(); }
  expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("retains failed camera measurements as unaccepted drafts with no content approval", async () => {
  const body = await request(); mocks.backend.mockResolvedValueOnce({ masks: [{ mask_png: null, request_id: "sam_failed" }] });
  const result = await verifyLocalIllustration("world", "view", body); const asset = "asset" in result ? result.asset : undefined;
  expect(asset?.keyframe).toMatchObject({ gate: "failed", passed: false }); expect(verifiedKeyframe(asset?.keyframe, asset?.sha256 ?? "")).toBe(false); expect(asset?.keyframe).not.toHaveProperty("content_approval"); expect(result.accepted).toBe(false);
});
it("cannot publish a measured eligible asset after the source changes during the paid call", async () => {
  const body = await request(); mocks.backend.mockImplementationOnce(async () => { mocks.art.mockResolvedValue({ key: "world/new-art.jpg", sha256: hash(Buffer.from("new source")) }); return { masks: [{ mask_png: mask.toString("base64") }] }; });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 });
  expect([...docs("illustration_local_verifications").values()][0]!.status).toBe("invalidated"); expect(docs("illustration_assets").size).toBe(1); expect(mocks.backend).toHaveBeenCalledTimes(1);
});
it("treats malformed gate receipts as unknown, without rerunning or trusting client claims", async () => {
  const body = await request(); mocks.backend.mockResolvedValueOnce({ masks: [{ mask_png: "invalid", passed: true }] });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 503 });
  expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("submission_unknown"); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(docs("illustration_assets").size).toBe(1);
});
it("does not call the backend when the ledger ceiling rejects a reservation", async () => {
  const body = await request(); mocks.reserve.mockRejectedValueOnce(new CreatorError("Spend cap reached", 429));
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 429 }); expect(mocks.backend).not.toHaveBeenCalled(); expect(docs("illustration_local_verifications").size).toBe(0);
});
it("keeps idempotent verification reads after a later legitimate owner review and acceptance", async () => {
  const body = await request(), first = await verifyLocalIllustration("world", "view", body), asset = "asset" in first ? first.asset : undefined; expect(asset).toBeDefined();
  const stored = docs("illustration_assets").get(`world:${asset!.id}`)!;
  (stored.keyframe as Record<string, unknown>).content_approval = { version: 1, method: "owner_review", sha256: imported.sha256, reviewed_at: new Date().toISOString() };
  docs("place_views").get(view._id)!.accepted_illustration_id = asset!.id;
  const read = await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256), replay = await verifyLocalIllustration("world", "view", body);
  expect(read).toMatchObject({ accepted: true, accepted_id: asset!.id, asset: { keyframe: { content_approval: { sha256: imported.sha256 } } } }); expect(replay).toMatchObject({ accepted: true, accepted_id: asset!.id });
  expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1); expect((stored.keyframe as Record<string, unknown>).content_approval).toBeDefined();
});
it("rejects reuse of one request UUID for another source asset before a second reservation or SAM", async () => {
  const body = await request(); await verifyLocalIllustration("world", "view", body);
  const asset = structuredClone(docs("illustration_assets").get(`world:${imported.id}`)!), original = structuredClone(docs("illustration_local_imports").get(`world:${imported.id}`)!);
  const other = "local_12233445-6677-4889-9aab-ccddeeff0033";
  asset._id = original._id = `world:${other}`; asset.id = original.id = original.asset_id = other; asset.key = `world/illustrations/${other}/${imported.sha256}.jpg`;
  const raw = original.raw as { key: string }, receipt = original.receipt as { key: string };
  const oldRaw = blobs.get(raw.key)!, oldReceipt = blobs.get(receipt.key)!; raw.key = raw.key.replace(imported.id, other); receipt.key = receipt.key.replace(imported.id, other);
  blobs.set(asset.key as string, { bytes: image, contentType: "image/jpeg" }); blobs.set(raw.key, oldRaw); blobs.set(receipt.key, oldReceipt);
  docs("illustration_assets").set(asset._id as string, asset); docs("illustration_local_imports").set(original._id as string, original);
  const quote = (await quoteLocalIllustrationVerification("world", "view", other, imported.sha256)).quote;
  await expect(verifyLocalIllustration("world", "view", { id: verifyId, asset_id: other, asset_sha256: imported.sha256, quote })).rejects.toMatchObject({ status: 409 }); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("fences ROI edits made after preparation and before the paid claim", async () => {
  const body = await request(), transaction = mocks.transaction.getMockImplementation()!;
  mocks.transaction.mockImplementationOnce(async run => {
    ([...docs("source_landmark_references").values()][0]!.landmarks as { left: number }[])[0]!.left++;
    return transaction(run);
  });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 }); expect(mocks.backend).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
});
it("does not publish when an ROI changes after measurement but just before the final transaction", async () => {
  const body = await request(), upload = mocks.upload.getMockImplementation()!;
  mocks.upload.mockImplementationOnce(async (...args) => {
    await upload(...args); ([...docs("source_landmark_references").values()][0]!.landmarks as { top: number }[])[1]!.top++;
  });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 }); expect(docs("illustration_assets").size).toBe(1); expect([...docs("illustration_local_verifications").values()][0]!.status).toBe("invalidated"); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("opts into server-derived visual geometry, verifies the complete trusted proof and replays the saved profile without a query", async () => {
  const { body, expected, objects } = await visualRequest(); expect(body.quote).toMatchObject({ reservation: .01, segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE });
  const result = await verifyLocalIllustration("world", "view", body), asset = "asset" in result ? result.asset : undefined;
  expect(result.verification).toMatchObject({ status: "ready", segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE }); expect(asset?.keyframe).toMatchObject({ passed: true, final_image: { sha256: hash(image) } });
  expect(mocks.backend.mock.calls[0]?.[2]).toEqual({ image_urls: [`data:image/jpeg;base64,${image.toString("base64")}`], width: 688, height: 384, label: "building", box: [0, 0, 160, 280], segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE, visual_geometry: expected.geometry });
  expect(expected.geometry.objects_data_url).toBe(`data:image/png;base64,${objects.toString("base64")}`);
  const stored = docs("illustration_assets").get(`world:${asset!.id}`)!; expect(stored.parameters).toMatchObject({ verification: { segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE, visual_prompt_proof: expected.proof } });
  (stored.keyframe as Record<string, unknown>).content_approval = { version: 1, method: "owner_review", sha256: imported.sha256, reviewed_at: new Date().toISOString() }; docs("place_views").get(view._id)!.accepted_illustration_id = asset!.id;
  expect(await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256)).toMatchObject({ quote: null, accepted: true, verification: { segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE } });
  const { segmentation_profile: _profile, ...withoutSelector } = body;
  expect(await verifyLocalIllustration("world", "view", withoutSelector)).toMatchObject({ accepted: true }); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("does not accept client geometry, unquoted profiles or a profile change on an existing default claim", async () => {
  const ordinary = await request();
  await expect(quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256, "other-profile")).rejects.toMatchObject({ status: 400 });
  await expect(verifyLocalIllustration("world", "view", { ...ordinary, visual_geometry: { subject_rgb: [1, 2, 3] } })).rejects.toMatchObject({ status: 400 });
  await verifyLocalIllustration("world", "view", ordinary);
  await expect(quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256, LOCAL_VISUAL_SEGMENTATION_PROFILE)).rejects.toMatchObject({ status: 409 });
  await expect(verifyLocalIllustration("world", "view", { ...ordinary, segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE })).rejects.toMatchObject({ status: 409 }); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it.each(["image", "points"])("keeps mismatched visual %s acknowledgements unknown and cannot remeasure them", async changed => {
  const { body, expected } = await visualRequest();
  const proof = structuredClone(expected.proof);
  if (changed === "image") proof.image_sha256 = hash(Buffer.from("different JPEG")); else proof.point_prompts[0]!.x++;
  mocks.backend.mockResolvedValueOnce({ segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE, masks: [{ mask_png: mask.toString("base64"), request_id: "sam_visual", visual_prompt_proof: proof }] });
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 503 });
  expect(await quoteLocalIllustrationVerification("world", "view", imported.id, imported.sha256)).toMatchObject({ quote: null, verification: { status: "submission_unknown", segmentation_profile: LOCAL_VISUAL_SEGMENTATION_PROFILE } });
  expect((await verifyLocalIllustration("world", "view", body)).verification.status).toBe("submission_unknown"); expect(mocks.backend).toHaveBeenCalledTimes(1); expect(docs("illustration_assets").size).toBe(1);
});
it("rejects missing road geometry and mismatched visual quote selectors before any spend", async () => {
  const { body } = await visualRequest();
  const { segmentation_profile: _profile, ...unquoted } = body;
  await expect(verifyLocalIllustration("world", "view", unquoted)).rejects.toMatchObject({ status: 409 });
  const source = docs("place_scenes").get("world:place")!, definition = source.definition as { objects: { kind: string }[] }; definition.objects[4]!.kind = "pond";
  await expect(verifyLocalIllustration("world", "view", body)).rejects.toMatchObject({ status: 409 }); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.backend).not.toHaveBeenCalled();
});
