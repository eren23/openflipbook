/** Owner-supplied camera drafts. No provider job, gate call or acceptance. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Db } from "mongodb";
import sharp from "sharp";
import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { illustrationDependency, illustrationSource, keyframeArt, keyframeViewPasses, prepareKeyframeViewInput } from "./illustration-input";
import { finishKeyframe } from "./illustration-keyframe-server";
import type { MeshAssetDoc, ViewDependency } from "./mesh-docs";
import { VIEW_PASSES, type IllustrationKeyframeInput } from "./place-view";
import { fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import type { SceneDoc } from "./place-scene-store";
import { getStoredBytes, uploadJpeg } from "./r2";

export const LOCAL_ILLUSTRATION_MODEL = "owner/local-keyframe-v1";
export const LOCAL_IMAGE_LIMIT = 8 * 1024 * 1024;
export const LOCAL_RECEIPT_LIMIT = 256 * 1024;
export const LOCAL_IMPORT_BODY_LIMIT = 12 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shaValue = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
interface File { key: string; sha256: string; bytes: number; content_type: string }
interface LocalImportDoc { _id: string; session_id: string; id: string; request_sha256: string; view_dependency: ViewDependency; created_at: Date; raw: File; receipt: File; asset_id?: string }

async function exactStored(file: File, expected: Buffer) {
  const saved = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!saved || saved.bytes.length !== file.bytes || sha(saved.bytes) !== file.sha256 || !saved.bytes.equals(expected)) throw new CreatorError("Stored local draft bytes failed verification", 503);
}

export async function importLocalIllustration(sid: string, viewId: string, input: Record<string, unknown>) {
  if (!isSafeId(viewId)) throw new CreatorError("Invalid camera view", 400);
  const db = await requireCreator(sid);
  if (!uuid(input.id) || Object.keys(input).some(key => !["id", "image_data_url", "image_sha256", "receipt_json", "receipt_sha256"].includes(key))
    || typeof input.image_data_url !== "string" || typeof input.receipt_json !== "string" || !shaValue(input.image_sha256) || !shaValue(input.receipt_sha256)) throw new CreatorError("Invalid owner-supplied draft import", 400);
  const requestId = input.id;
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${viewId}`, session_id: sid });
  if (!view) throw new CreatorError("Saved camera view not found", 404);
  const rootPlaceId = view.root_place_id;
  if (view.walk_checkpoint || view.width !== 688 || view.height !== 384) throw new CreatorError("Local drafts require an ordinary 688 × 384 saved camera", 409);
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]*={0,2})$/.exec(input.image_data_url);
  if (!match || match[2]!.length > Math.ceil(LOCAL_IMAGE_LIMIT / 3) * 4 || match[2]!.length % 4 !== 0) throw new CreatorError("Upload one bounded PNG or JPEG", 400);
  const raw = Buffer.from(match[2]!, "base64"), receipt = Buffer.from(input.receipt_json, "utf8");
  if (!raw.length || raw.length > LOCAL_IMAGE_LIMIT || raw.toString("base64") !== match[2]) throw new CreatorError("Invalid local draft image bytes", 400);
  if (!receipt.length || receipt.length > LOCAL_RECEIPT_LIMIT) throw new CreatorError("Local draft receipt exceeds 256 KiB", 413);
  if (sha(raw) !== input.image_sha256 || sha(receipt) !== input.receipt_sha256) throw new CreatorError("Local draft image or receipt hash differs", 400);
  let evidence: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(input.receipt_json); if (!object(parsed)) throw new Error(); evidence = parsed; }
  catch { throw new CreatorError("Invalid local draft receipt JSON", 400); }
  const fields = ["version", "kind", "view_id", "input_sha256", "camera_sha256", "scene_id", "scene_revision", "definition_sha256", "source_sha256", "image_sha256", "pass_sha256", "origin"];
  if (Object.keys(evidence).some(key => !fields.includes(key)) || evidence.version !== 1 || evidence.kind !== LOCAL_ILLUSTRATION_MODEL || evidence.origin !== undefined && !object(evidence.origin)) throw new CreatorError("Receipt must describe an unmeasured owner-supplied draft", 400);
  const dependency = illustrationDependency(view);
  await illustrationSource(db, sid, dependency);
  const root = view.sources.find(source => source.place_id === view.root_place_id);
  const reference = await keyframeArt(db, sid, view.root_place_id);
  if (!root || !reference) throw new CreatorError("A current source-bound saved camera is required", 409);
  const passHashes = Object.fromEntries(VIEW_PASSES.map(pass => [pass, view.files[pass].sha256]));
  if (evidence.view_id !== viewId || evidence.input_sha256 !== dependency.input_sha256 || evidence.camera_sha256 !== viewHash(view.camera)
    || evidence.scene_id !== root.scene_id || evidence.scene_revision !== root.revision || evidence.definition_sha256 !== root.definition_sha256
    || evidence.source_sha256 !== reference.sha256 || evidence.image_sha256 !== sha(raw) || !isDeepStrictEqual(evidence.pass_sha256, passHashes)) throw new CreatorError("Local draft receipt belongs to a different source or saved camera", 409);
  const request: IllustrationKeyframeInput = { stage: "first", art: "art", reference, reference_profile: "source-art-map-landmarks-v1", reference_guidance: "saved-camera-controlnet-v1", gate_object_id: null };
  const prepared = await prepareKeyframeViewInput(db, sid, dependency, request);
  const preparation = prepared.reference_preparation;
  if (!preparation || preparation.version !== "source-art-map-landmarks-v1" || preparation.source_sha256 !== reference.sha256 || preparation.landmarks?.length !== 4 || preparation.structural_guidance?.version !== "saved-camera-controlnet-v1") throw new CreatorError("Four current source landmarks and camera guides are required", 409);
  let metadata: sharp.Metadata;
  try { metadata = await sharp(raw, { limitInputPixels: 688 * 384, failOn: "error" }).metadata(); }
  catch { throw new CreatorError("Local draft image is unreadable", 400); }
  if (metadata.width !== 688 || metadata.height !== 384 || (metadata.pages ?? 1) !== 1 || metadata.orientation && metadata.orientation !== 1
    || metadata.format !== (match[1] === "image/png" ? "png" : "jpeg")) throw new CreatorError("Local draft must be one upright 688 × 384 PNG or JPEG", 400);
  const rgba = await sharp(raw, { limitInputPixels: 688 * 384, failOn: "error" }).toColourspace("srgb").ensureAlpha().raw().toBuffer();
  if (rgba.some((channel, index) => index % 4 === 3 && channel !== 255)) throw new CreatorError("Local draft must be opaque", 400);
  const jpeg = metadata.format === "jpeg" ? raw : await sharp(raw).toColourspace("srgb").removeAlpha().jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const id = `local_${requestId}`, key = `${sid}:${id}`, rawHash = sha(raw), receiptHash = sha(receipt);
  const rawFile: File = { key: `${sid}/illustrations/local/${id}/raw-${rawHash}.${metadata.format === "png" ? "png" : "jpg"}`, sha256: rawHash, bytes: raw.length, content_type: match[1]! };
  const receiptFile: File = { key: `${sid}/illustrations/local/${id}/receipt-${receiptHash}.json`, sha256: receiptHash, bytes: receipt.length, content_type: "application/json" };
  const requestHash = viewHash({ dependency, raw_sha256: rawHash, receipt_sha256: receiptHash, reference_preparation: preparation });
  const same = (old: LocalImportDoc) => { if (old.request_sha256 !== requestHash || old.session_id !== sid) throw new CreatorError("Local import request id already used for different bytes or source", 409); };
  async function current(transactionDb: Db, session: ClientSession) {
    const current = await illustrationSource(transactionDb, sid, dependency, session);
    const scene = await transactionDb.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${rootPlaceId}`, session_id: sid }, { session });
    if (!scene || scene.source_image_key !== reference!.key) throw new CreatorError("Source artwork changed during local import", 409);
    return current;
  }
  const claim = await withDbTransaction(async (transactionDb, session) => {
    const collection = transactionDb.collection<LocalImportDoc>("illustration_local_imports"), options = { session };
    const old = await collection.findOne({ _id: key, session_id: sid }, options);
    if (old) { same(old); return old; }
    const now = new Date();
    if (await collection.countDocuments({ session_id: sid, created_at: { $gte: new Date(now.getTime() - 60_000) } }, options) >= 10) throw new CreatorError("Wait before importing more local drafts", 429);
    const checked = await current(transactionDb, session);
    const scope = { session_id: sid, "view_dependency.view_id": viewId };
    if (await collection.countDocuments(scope, options) + await transactionDb.collection("illustration_jobs").countDocuments(scope, options)
      + await transactionDb.collection("illustration_assets").countDocuments({ ...scope, $or: [{ region_edit: { $exists: true } }, { geometry_refresh: { $exists: true } }] }, options) >= 50) throw new CreatorError("This camera already has 50 illustration requests or edits", 409);
    await fenceViewSources(transactionDb, checked, session);
    const doc: LocalImportDoc = { _id: key, session_id: sid, id, request_sha256: requestHash, view_dependency: dependency, created_at: now, raw: rawFile, receipt: receiptFile };
    await collection.insertOne(doc, options);
    return doc;
  });
  const response = async (asset: MeshAssetDoc) => {
    await exactStored(rawFile, raw); await exactStored(receiptFile, receipt);
    const saved = await getStoredBytes(asset.key, AbortSignal.timeout(30_000));
    if (!saved || saved.bytes.length !== asset.bytes || sha(saved.bytes) !== asset.sha256 || !saved.bytes.equals(jpeg) || asset.keyframe?.gate !== "unmeasured" || asset.keyframe.passed || asset.keyframe.content_approval) throw new CreatorError("Stored local draft provenance failed verification", 503);
    return { id: asset.id, model: asset.model, sha256: asset.sha256, content_type: "image/jpeg" as const, accepted: false, gate: "unmeasured" as const,
      raw: rawFile, receipt: receiptFile, normalization: { method: metadata.format === "jpeg" ? "none" : "png_to_srgb_jpeg_v1", raw_sha256: rawHash, final_sha256: asset.sha256 }, keyframe: asset.keyframe };
  };
  if (claim.asset_id) {
    const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${claim.asset_id}`, session_id: sid });
    if (!asset) throw new CreatorError("Imported local draft is unavailable", 503);
    return response(asset);
  }
  const passes = await keyframeViewPasses(view), finished = await finishKeyframe(passes, prepared.gate_object_id, [jpeg], null);
  const { bytes, ...measurements } = finished;
  const keyframe: NonNullable<MeshAssetDoc["keyframe"]> = { version: 1, stage: "first", art: "art", reference, reference_profile: request.reference_profile!, reference_guidance: request.reference_guidance!, reference_preparation: preparation,
    object_id: prepared.gate_object_id, gate_subject: prepared.gate_subject, ...measurements, gate: "unmeasured", passed: false, candidates: measurements.candidates.map(candidate => ({ ...candidate, passed: false })) };
  const hash = sha(bytes), finalKey = `${sid}/illustrations/${id}/${hash}.jpg`;
  for (const [file, data] of [[rawFile, raw], [receiptFile, receipt]] as const) await uploadJpeg(file.key, data, file.content_type, AbortSignal.timeout(90_000));
  await uploadJpeg(finalKey, bytes, "image/jpeg", AbortSignal.timeout(90_000));
  const asset = await withDbTransaction(async (transactionDb, session) => {
    const options = { session }, imports = transactionDb.collection<LocalImportDoc>("illustration_local_imports");
    const old = await imports.findOne({ _id: key, session_id: sid }, options);
    if (!old) throw new CreatorError("Local import reservation is missing", 503);
    same(old);
    const assets = transactionDb.collection<MeshAssetDoc>("illustration_assets"), existing = await assets.findOne({ _id: key, session_id: sid }, options);
    if (existing) return existing;
    const checked = await current(transactionDb, session);
    await fenceViewSources(transactionDb, checked, session);
    const doc: MeshAssetDoc = { _id: key, id, session_id: sid, key: finalKey, sha256: hash, bytes: bytes.length, content_type: "image/jpeg", model: LOCAL_ILLUSTRATION_MODEL, prompt: "Owner-supplied source-bound draft; camera consistency unmeasured.", request_id: requestId, created_at: claim.created_at,
      parameters: { provenance: LOCAL_ILLUSTRATION_MODEL, provider_submissions: 0, request_sha256: requestHash, raw: rawFile, receipt: receiptFile, normalization: metadata.format === "jpeg" ? "none" : "png_to_srgb_jpeg_v1" }, view_dependency: dependency, illustration: { width: 688, height: 384, color_space: "srgb" }, keyframe };
    await assets.insertOne(doc, options);
    await imports.updateOne({ _id: key }, { $set: { asset_id: id } }, options);
    return doc;
  });
  return response(asset);
}
