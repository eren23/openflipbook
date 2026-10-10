/** One trusted camera measurement of an owner-imported draft. Never generates or accepts art. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Db } from "mongodb";
import sharp from "sharp";
import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import { reserveGenerationSpend } from "./generation-reservation";
import { isSafeId } from "./ids";
import { illustrationDependency, illustrationSource, keyframeArt, keyframeViewPasses, prepareKeyframeViewInput } from "./illustration-input";
import { finishKeyframe, keyframeGateBody } from "./illustration-keyframe-server";
import type { LandmarkReferenceDoc } from "./illustration-landmarks";
import { LOCAL_ILLUSTRATION_MODEL, LOCAL_IMAGE_LIMIT, LOCAL_RECEIPT_LIMIT } from "./illustration-local-import";
import { LOCAL_VISUAL_SEGMENTATION_PROFILE, localVisualGeometry, type LocalSegmentationProfile } from "./illustration-local-visual";
import { assetBackend } from "./mesh-execution";
import type { MeshAssetDoc, ViewDependency } from "./mesh-docs";
import { VIEW_PASSES, type IllustrationKeyframeInput } from "./place-view";
import { fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import type { SceneDoc } from "./place-scene-store";
import { getStoredBytes, uploadJpeg } from "./r2";

export const LOCAL_VERIFICATION_VERSION = "owner/local-keyframe-verification-v1";
export const LOCAL_VERIFICATION_RESERVATION = .01;
export const LOCAL_VERIFICATION_BODY_LIMIT = 16 * 1024;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
interface File { key: string; sha256: string; bytes: number; content_type: string }
interface ImportDoc { _id: string; session_id: string; id: string; asset_id?: string; view_dependency: ViewDependency; raw: File; receipt: File }
interface Quote { version: 1; kind: typeof LOCAL_VERIFICATION_VERSION; reservation: number; request_sha256: string; issued_at: string; expires_at: string; sha256: string; segmentation_profile?: LocalSegmentationProfile }
interface VerificationDoc {
  _id: string; session_id: string; id: string; source_asset_id: string; source_asset_sha256: string; request_sha256: string;
  quote: Quote; created_at: Date; ledger_ids: string[]; reservation: number;
  segmentation_profile?: LocalSegmentationProfile;
  status: "submitting" | "submission_unknown" | "measured" | "ready" | "invalidated";
  gate_response?: { masks: { mask_png: string | null; request_id?: string; visual_prompt_proof?: Awaited<ReturnType<typeof localVisualGeometry>>["proof"] }[]; segmentation_profile?: LocalSegmentationProfile }; asset_id?: string;
}
function profile(value: unknown): LocalSegmentationProfile | undefined {
  if (value === undefined) return undefined;
  if (value !== LOCAL_VISUAL_SEGMENTATION_PROFILE) throw new CreatorError("Unsupported local measurement profile", 400);
  return value;
}
function savedProfile(claim: VerificationDoc | null, requested: LocalSegmentationProfile | undefined) {
  if (!claim) return requested;
  const saved = profile(claim.segmentation_profile);
  if (requested !== undefined && requested !== saved) throw new CreatorError("This local draft already has a different measurement profile", 409);
  return saved;
}

async function exactBytes(file: File, limit: number) {
  if (!hash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > limit) throw new CreatorError("Local draft byte descriptor is invalid", 409);
  const stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!stored || stored.bytes.length !== file.bytes || sha(stored.bytes) !== file.sha256 || stored.contentType.split(";")[0] !== file.content_type) throw new CreatorError("Local draft stored bytes differ", 503);
  return stored.bytes;
}

async function inputs(db: Db, sid: string, viewId: string, assetId: string, assetSha: string, segmentationProfile?: LocalSegmentationProfile) {
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${viewId}`, session_id: sid });
  const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${assetId}`, session_id: sid });
  if (!view || !asset) throw new CreatorError("Owned local draft or camera not found", 404);
  if (view.walk_checkpoint || view.width !== 688 || view.height !== 384 || asset.model !== LOCAL_ILLUSTRATION_MODEL || asset.sha256 !== assetSha
    || asset.content_type !== "image/jpeg" || asset.key !== `${sid}/illustrations/${assetId}/${assetSha}.jpg`
    || !asset.view_dependency || !isDeepStrictEqual(asset.view_dependency, illustrationDependency(view))
    || asset.keyframe?.gate !== "unmeasured" || asset.keyframe.passed || asset.keyframe.content_approval || asset.keyframe.stage !== "first") throw new CreatorError("Verification requires the exact unmeasured ordinary local draft", 409);
  const imported = await db.collection<ImportDoc>("illustration_local_imports").findOne({ _id: `${sid}:${assetId}`, session_id: sid });
  if (!imported || imported.asset_id !== assetId || imported.id !== assetId || !isDeepStrictEqual(imported.view_dependency, asset.view_dependency)
    || !["image/png", "image/jpeg"].includes(imported.raw.content_type)
    || imported.raw.key !== `${sid}/illustrations/local/${assetId}/raw-${imported.raw.sha256}.${imported.raw.content_type === "image/png" ? "png" : "jpg"}`
    || imported.receipt.key !== `${sid}/illustrations/local/${assetId}/receipt-${imported.receipt.sha256}.json` || imported.receipt.content_type !== "application/json") throw new CreatorError("Local import provenance is missing or changed", 409);
  const dependency = asset.view_dependency;
  await illustrationSource(db, sid, dependency);
  const root = view.sources.find(source => source.place_id === view.root_place_id), reference = await keyframeArt(db, sid, view.root_place_id);
  if (!root || !reference) throw new CreatorError("A current source-bound camera is required", 409);
  const [jpeg, raw, receipt] = await Promise.all([
    exactBytes({ key: asset.key, sha256: asset.sha256, bytes: asset.bytes, content_type: "image/jpeg" }, LOCAL_IMAGE_LIMIT),
    exactBytes(imported.raw, LOCAL_IMAGE_LIMIT), exactBytes(imported.receipt, LOCAL_RECEIPT_LIMIT),
  ]);
  let evidence: Record<string, unknown>;
  try { const value: unknown = JSON.parse(receipt.toString("utf8")); if (!object(value)) throw new Error(); evidence = value; }
  catch { throw new CreatorError("Local import receipt is unreadable", 409); }
  const passHashes = Object.fromEntries(VIEW_PASSES.map(pass => [pass, view.files[pass].sha256]));
  if (evidence.version !== 1 || evidence.kind !== LOCAL_ILLUSTRATION_MODEL || evidence.view_id !== viewId || evidence.input_sha256 !== dependency.input_sha256
    || evidence.camera_sha256 !== viewHash(view.camera) || evidence.scene_id !== root.scene_id || evidence.scene_revision !== root.revision
    || evidence.definition_sha256 !== root.definition_sha256 || evidence.source_sha256 !== reference.sha256 || evidence.image_sha256 !== imported.raw.sha256
    || !isDeepStrictEqual(evidence.pass_sha256, passHashes)) throw new CreatorError("Local import receipt belongs to another source or camera", 409);
  const metadata = await sharp(jpeg, { limitInputPixels: 688 * 384, failOn: "error" }).metadata();
  if (metadata.format !== "jpeg" || metadata.width !== 688 || metadata.height !== 384 || (metadata.pages ?? 1) !== 1 || metadata.orientation && metadata.orientation !== 1) throw new CreatorError("Verification requires an upright 688 × 384 JPEG", 409);
  const normalized = imported.raw.content_type === "image/jpeg" ? raw : await sharp(raw, { limitInputPixels: 688 * 384, failOn: "error" }).toColourspace("srgb").removeAlpha().jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  if (!jpeg.equals(normalized)) throw new CreatorError("Local draft normalization bytes differ", 409);
  // Verify all four saved pass files, including normals, before reserving spend.
  await Promise.all(VIEW_PASSES.map(pass => exactBytes({ ...view.files[pass], content_type: "image/png" }, 8 * 1024 * 1024)));
  const request: IllustrationKeyframeInput = { stage: "first", art: "art", reference, reference_profile: "source-art-map-landmarks-v1", reference_guidance: "saved-camera-controlnet-v1", gate_object_id: null };
  const prepared = await prepareKeyframeViewInput(db, sid, dependency, request), preparation = prepared.reference_preparation;
  if (!preparation || preparation.version !== request.reference_profile || preparation.source_sha256 !== reference.sha256 || preparation.landmarks?.length !== 4
    || preparation.structural_guidance?.version !== request.reference_guidance || !isDeepStrictEqual(asset.keyframe.reference_preparation, preparation)
    || asset.keyframe.object_id !== prepared.gate_object_id || !isDeepStrictEqual(asset.keyframe.gate_subject, prepared.gate_subject)) throw new CreatorError("Local draft source landmarks or camera guides changed", 409);
  const passes = await keyframeViewPasses(view), ordinaryBody = await keyframeGateBody(passes, prepared.gate_object_id, [`data:image/jpeg;base64,${jpeg.toString("base64")}`], prepared.gate_subject?.label);
  if (!ordinaryBody || !prepared.gate_object_id) throw new CreatorError("The saved camera has no measurable foreground subject", 409);
  let visual: Awaited<ReturnType<typeof localVisualGeometry>> | undefined;
  if (segmentationProfile) {
    const source = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${view.root_place_id}`, session_id: sid });
    if (!source?.definition || viewHash(source.definition) !== root.definition_sha256 || sha(passes.objects) !== view.files.objects.sha256) throw new CreatorError("Visual measurement source geometry changed", 409);
    visual = await localVisualGeometry(view, source.definition, preparation.landmarks.map(l => l.label), prepared.gate_object_id, passes.objects, jpeg, ordinaryBody.box);
  }
  const body = visual ? { ...ordinaryBody, segmentation_profile: segmentationProfile!, visual_geometry: visual.geometry } : ordinaryBody;
  const fingerprint = { version: LOCAL_VERIFICATION_VERSION, source_asset_id: assetId, source_asset_sha256: assetSha, dependency, source: root,
    reference, reference_preparation: preparation, raw: imported.raw, receipt: imported.receipt, pass_sha256: passHashes, gate_body_sha256: viewHash(body), ...(segmentationProfile ? { segmentation_profile: segmentationProfile } : {}) };
  return { view, asset, imported, dependency, reference, prepared, passes, body, jpeg, visual, segmentationProfile, request_sha256: viewHash(fingerprint) };
}
type Inputs = Awaited<ReturnType<typeof inputs>>;

async function fence(db: Db, sid: string, value: Inputs, session: ClientSession) {
  const checked = await illustrationSource(db, sid, value.dependency, session), options = { session };
  const source = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${value.view.root_place_id}`, session_id: sid }, options);
  const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: value.asset._id, session_id: sid }, options);
  if (!source || source.source_image_key !== value.reference.key || !asset || asset.sha256 !== value.asset.sha256 || viewHash(asset.parameters) !== viewHash(value.asset.parameters)
    || !isDeepStrictEqual(asset.view_dependency, value.dependency) || asset.keyframe?.gate !== "unmeasured" || asset.keyframe.passed || asset.keyframe.content_approval
    || !isDeepStrictEqual(asset.keyframe.reference_preparation, value.prepared.reference_preparation)) throw new CreatorError("Local draft or source changed during verification", 409);
  const references = db.collection<LandmarkReferenceDoc & { local_verification_fence?: number }>("source_landmark_references");
  const referenceRow = await references.findOne({ _id: `${sid}:${value.view.root_place_id}:${value.reference.sha256}`, session_id: sid, place_id: value.view.root_place_id, source_sha256: value.reference.sha256 }, options);
  const preparation = value.prepared.reference_preparation!;
  const rectangles = preparation.landmarks!.map(({ label, left, top, width, height }) => ({ label, left, top, width, height }));
  if (!referenceRow || referenceRow.source_width !== preparation.source_width || referenceRow.source_height !== preparation.source_height || !isDeepStrictEqual(referenceRow.landmarks, rectangles)) throw new CreatorError("Source building references changed during verification", 409);
  // Landmark edits do not increment scene revisions. A write to their own row
  // serializes the current ROI check with the existing owner reference action.
  if (!(await references.updateOne({ _id: referenceRow._id, session_id: sid }, { $inc: { local_verification_fence: 1 } }, options)).matchedCount) throw new CreatorError("Source building references changed", 409);
  await fenceViewSources(db, checked, session);
  if (!(await db.collection<PlaceViewDoc>("place_views").updateOne({ _id: checked._id, session_id: sid }, { $inc: { source_use_fence: 1 } }, options)).matchedCount) throw new CreatorError("Saved camera changed", 409);
}
async function response(db: Db, sid: string, claim: VerificationDoc) {
  if (claim.status !== "ready" || !claim.asset_id) return { quote: null, verification: { id: claim.id, status: claim.status, reservation: claim.reservation, source_asset_id: claim.source_asset_id, source_asset_sha256: claim.source_asset_sha256, request_sha256: claim.request_sha256, ...(claim.segmentation_profile ? { segmentation_profile: claim.segmentation_profile } : {}) }, accepted: false };
  const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${claim.asset_id}`, session_id: sid });
  if (!asset?.keyframe) throw new CreatorError("Measured local draft is unavailable", 503);
  await exactBytes({ key: asset.key, sha256: asset.sha256, bytes: asset.bytes, content_type: "image/jpeg" }, LOCAL_IMAGE_LIMIT);
  const view = asset.view_dependency ? await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${asset.view_dependency.view_id}`, session_id: sid }) : null;
  return { quote: null, verification: { id: claim.id, status: claim.status, reservation: claim.reservation, source_asset_id: claim.source_asset_id, source_asset_sha256: claim.source_asset_sha256, request_sha256: claim.request_sha256, ...(claim.segmentation_profile ? { segmentation_profile: claim.segmentation_profile } : {}) },
    asset: { id: asset.id, model: asset.model, sha256: asset.sha256, content_type: "image/jpeg", keyframe: asset.keyframe }, accepted: view?.accepted_illustration_id === asset.id, accepted_id: view?.accepted_illustration_id ?? null };
}
function ids(viewId: string, assetId: unknown, assetSha: unknown): asserts assetId is string {
  if (!isSafeId(viewId) || !isSafeId(assetId) || !hash(assetSha)) throw new CreatorError("Invalid local verification source", 400);
}
export async function quoteLocalIllustrationVerification(sid: string, viewId: string, assetId: string, assetSha: string, segmentationProfile?: unknown) {
  const db = await requireCreator(sid); ids(viewId, assetId, assetSha);
  const existing = await db.collection<VerificationDoc>("illustration_local_verifications").findOne({ _id: `${sid}:${assetId}`, session_id: sid });
  const selectedProfile = savedProfile(existing, profile(segmentationProfile)), value = await inputs(db, sid, viewId, assetId, assetSha, selectedProfile);
  if (existing && (existing.source_asset_sha256 !== assetSha || existing.request_sha256 !== value.request_sha256)) throw new CreatorError("Local measurement source changed", 409);
  if (existing) return response(db, sid, existing);
  const now = Date.now(), quoted = { version: 1 as const, kind: LOCAL_VERIFICATION_VERSION, reservation: LOCAL_VERIFICATION_RESERVATION, request_sha256: value.request_sha256,
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * 60_000).toISOString(), ...(selectedProfile ? { segmentation_profile: selectedProfile } : {}) };
  return { quote: { ...quoted, sha256: viewHash(quoted) }, source_asset_id: assetId, source_asset_sha256: assetSha, accepted: false };
}
function checkedQuote(input: unknown, fingerprint: string, segmentationProfile?: LocalSegmentationProfile): Quote {
  if (!object(input) || Object.keys(input).length !== (segmentationProfile ? 8 : 7) || Object.keys(input).some(key => !["version", "kind", "reservation", "request_sha256", "issued_at", "expires_at", "sha256", ...(segmentationProfile ? ["segmentation_profile"] : [])].includes(key))) throw new CreatorError("Review the current local verification quote", 409);
  const { sha256, ...quoted } = input, issued = typeof input.issued_at === "string" ? Date.parse(input.issued_at) : NaN, expires = typeof input.expires_at === "string" ? Date.parse(input.expires_at) : NaN;
  if (input.version !== 1 || input.kind !== LOCAL_VERIFICATION_VERSION || input.reservation !== LOCAL_VERIFICATION_RESERVATION || input.request_sha256 !== fingerprint || input.segmentation_profile !== segmentationProfile || sha256 !== viewHash(quoted)
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > Date.now() + 5000 || expires <= Date.now() || expires - issued !== 10 * 60_000) throw new CreatorError("Local verification quote changed or expired", 409);
  return input as unknown as Quote;
}
async function gateResponse(input: unknown, value: Inputs): Promise<NonNullable<VerificationDoc["gate_response"]>> {
  if (!object(input) || !Array.isArray(input.masks) || input.masks.length !== 1 || !object(input.masks[0])) throw new CreatorError("Camera measurement acknowledgement is invalid", 503);
  const mask = input.masks[0], maskPng = mask.mask_png;
  if (value.visual && (input.segmentation_profile !== value.segmentationProfile || !isSafeId(mask.request_id) || !isDeepStrictEqual(mask.visual_prompt_proof, value.visual.proof))) throw new CreatorError("Visual measurement acknowledgement differs from the saved source pixels", 503);
  if (maskPng !== null) {
    if (typeof maskPng !== "string" || maskPng.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(maskPng)) throw new CreatorError("Camera mask acknowledgement is invalid", 503);
    const bytes = Buffer.from(maskPng, "base64");
    if (bytes.toString("base64") !== maskPng) throw new CreatorError("Camera mask acknowledgement is invalid", 503);
    const metadata = await sharp(bytes, { limitInputPixels: 688 * 384, failOn: "error" }).metadata();
    if (metadata.format !== "png" || metadata.width !== 688 || metadata.height !== 384 || (metadata.pages ?? 1) !== 1 || metadata.orientation && metadata.orientation !== 1) throw new CreatorError("Camera mask differs from the saved frame", 503);
    await sharp(bytes, { limitInputPixels: 688 * 384, failOn: "error" }).raw().toBuffer();
  }
  return { masks: [{ mask_png: maskPng, ...(isSafeId(mask.request_id) ? { request_id: mask.request_id } : {}), ...(value.visual ? { visual_prompt_proof: value.visual.proof } : {}) }], ...(value.segmentationProfile ? { segmentation_profile: value.segmentationProfile } : {}) };
}
export async function verifyLocalIllustration(sid: string, viewId: string, input: Record<string, unknown>) {
  const db = await requireCreator(sid);
  if (!uuid(input.id) || Object.keys(input).some(key => !["id", "asset_id", "asset_sha256", "quote", "segmentation_profile"].includes(key))) throw new CreatorError("Invalid local verification request", 400);
  ids(viewId, input.asset_id, input.asset_sha256);
  const assetId = input.asset_id, assetSha = input.asset_sha256 as string, key = `${sid}:${assetId}`;
  const collection = db.collection<VerificationDoc>("illustration_local_verifications");
  const previous = await collection.findOne({ _id: key, session_id: sid }), selectedProfile = savedProfile(previous, profile(input.segmentation_profile));
  let value = await inputs(db, sid, viewId, assetId, assetSha, selectedProfile);
  const same = (old: VerificationDoc) => { if (old.id !== input.id || old.source_asset_sha256 !== assetSha || old.request_sha256 !== value.request_sha256 || !isDeepStrictEqual(old.quote, input.quote)) throw new CreatorError("This local draft already has a different verification request", 409); };
  if (previous) same(previous);
  const quote = previous?.quote ?? checkedQuote(input.quote, value.request_sha256, selectedProfile);
  if (!previous && !process.env.MODAL_API_URL) throw new CreatorError("Camera measurement backend is unavailable", 503);
  const reserved = await withDbTransaction(async (transactionDb, session) => {
    const claims = transactionDb.collection<VerificationDoc>("illustration_local_verifications"), options = { session }, old = await claims.findOne({ _id: key, session_id: sid }, options);
    const ids = transactionDb.collection<{ _id: string; session_id: string; source_asset_id: string; request_sha256: string }>("illustration_local_verification_ids"), requestKey = `${sid}:${input.id}`;
    const existingId = await ids.findOne({ _id: requestKey, session_id: sid }, options);
    if (existingId && (existingId.source_asset_id !== assetId || existingId.request_sha256 !== value.request_sha256)) throw new CreatorError("Verification request id already belongs to another local draft", 409);
    if (old) { same(old); return { claim: old, created: false }; }
    await fence(transactionDb, sid, value, session);
    if (!existingId) await ids.insertOne({ _id: requestKey, session_id: sid, source_asset_id: assetId, request_sha256: value.request_sha256 }, options);
    const now = new Date(), ledgerIds = await reserveGenerationSpend(transactionDb, session, sid, "illustration", LOCAL_VERIFICATION_RESERVATION, "ILLUSTRATION_DAILY_CAP_USD", now);
    const claim: VerificationDoc = { _id: key, session_id: sid, id: input.id as string, source_asset_id: assetId, source_asset_sha256: assetSha, request_sha256: value.request_sha256,
      quote, reservation: LOCAL_VERIFICATION_RESERVATION, ledger_ids: ledgerIds, created_at: now, status: "submitting", ...(selectedProfile ? { segmentation_profile: selectedProfile } : {}) };
    await claims.insertOne(claim, options);
    return { claim, created: true };
  });
  let claim = reserved.claim;
  if (reserved.created) {
    // The durable marker is never re-leased. Even HTTP refusal conservatively
    // retains the reservation; an interrupted reply never authorizes a retry.
    try {
      const measured = await gateResponse(await assetBackend("illustration", "gate", value.body, 200_000, 2_000_000), value);
      if (!(await collection.updateOne({ _id: key, id: claim.id, status: "submitting" }, { $set: { status: "measured", gate_response: measured } })).matchedCount) throw new Error("Local verification acknowledgement could not be saved");
      claim = { ...claim, status: "measured", gate_response: measured };
    } catch {
      await collection.updateOne({ _id: key, id: claim.id, status: "submitting" }, { $set: { status: "submission_unknown" } });
      throw new CreatorError("Camera measurement acknowledgement unavailable; this draft will not be charged or submitted again", 503);
    }
  }
  if (claim.status === "ready") return response(db, sid, claim);
  if (claim.status !== "measured" || !claim.gate_response) return response(db, sid, claim);
  // A known saved measurement can finish storage for free. Revalidate source
  // bytes and all camera/landmark bindings before creating any eligible asset.
  try {
    value = await inputs(db, sid, viewId, assetId, assetSha, claim.segmentation_profile);
    if (value.request_sha256 !== claim.request_sha256) throw new CreatorError("Source changed after camera measurement", 409);
    const { bytes, ...measurements } = await finishKeyframe(value.passes, value.prepared.gate_object_id, [value.jpeg], claim.gate_response.masks.map(mask => mask.mask_png));
    if (!bytes.equals(value.jpeg) || measurements.final_image.sha256 !== assetSha) throw new CreatorError("Camera measurement final bytes differ", 503);
    const id = `local_verified_${sha(Buffer.from(key)).slice(0, 16)}_${claim.id}`, assetKey = `${sid}/illustrations/${id}/${assetSha}.jpg`;
    await uploadJpeg(assetKey, bytes, "image/jpeg", AbortSignal.timeout(90_000));
    await exactBytes({ key: assetKey, sha256: assetSha, bytes: bytes.length, content_type: "image/jpeg" }, LOCAL_IMAGE_LIMIT);
    const result = await withDbTransaction(async (transactionDb, session) => {
      const options = { session }, claims = transactionDb.collection<VerificationDoc>("illustration_local_verifications");
      const saved = await claims.findOne({ _id: key, session_id: sid }, options);
      if (!saved || saved.id !== claim.id || saved.request_sha256 !== value.request_sha256 || !isDeepStrictEqual(saved.gate_response, claim.gate_response) || !["measured", "ready"].includes(saved.status)) throw new CreatorError("Saved camera measurement changed", 409);
      await fence(transactionDb, sid, value, session);
      const assets = transactionDb.collection<MeshAssetDoc>("illustration_assets"), existing = await assets.findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
      if (existing && (existing.sha256 !== assetSha || existing.model !== LOCAL_ILLUSTRATION_MODEL || !isDeepStrictEqual(existing.view_dependency, value.dependency)
        || !object(existing.parameters?.verification) || existing.parameters.verification.source_asset_id !== assetId || existing.parameters.verification.request_sha256 !== claim.request_sha256
        || existing.keyframe?.final_image?.sha256 !== assetSha)) throw new CreatorError("Stored measured derivative belongs to another verification", 409);
      if (!existing) {
        const asset: MeshAssetDoc = { _id: `${sid}:${id}`, id, session_id: sid, key: assetKey, sha256: assetSha, bytes: bytes.length, content_type: "image/jpeg", model: LOCAL_ILLUSTRATION_MODEL,
          prompt: "Owner-supplied source-bound draft with a trusted camera measurement; content awaits owner review.", request_id: claim.id, created_at: claim.created_at,
          parameters: { ...value.asset.parameters, verification: { version: LOCAL_VERIFICATION_VERSION, source_asset_id: assetId, source_asset_sha256: assetSha, request_sha256: claim.request_sha256, reservation: claim.reservation,
            gate_provider_submissions: 1, image_provider_submissions: 0, receipt: value.imported.receipt, raw: value.imported.raw, provider_request_ids: claim.gate_response!.masks.flatMap(mask => mask.request_id ? [mask.request_id] : []),
            ...(claim.segmentation_profile ? { segmentation_profile: claim.segmentation_profile, visual_prompt_proof: claim.gate_response!.masks[0]!.visual_prompt_proof } : {}) } },
          view_dependency: value.dependency, illustration: { width: 688, height: 384, color_space: "srgb" },
          keyframe: { version: 1, stage: "first", art: "art", reference: value.reference, reference_profile: "source-art-map-landmarks-v1", reference_guidance: "saved-camera-controlnet-v1",
            reference_preparation: value.prepared.reference_preparation!, object_id: value.prepared.gate_object_id, gate_subject: value.prepared.gate_subject, ...measurements } };
        await assets.insertOne(asset, options);
      }
      await claims.updateOne({ _id: key, id: claim.id }, { $set: { status: "ready", asset_id: id } }, options);
      return { ...saved, status: "ready" as const, asset_id: id };
    });
    return response(db, sid, result);
  } catch (error) {
    if (error instanceof CreatorError && error.status === 409) await collection.updateOne({ _id: key, status: "measured" }, { $set: { status: "invalidated" } });
    throw error;
  }
}
