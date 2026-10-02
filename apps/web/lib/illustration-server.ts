import { isDeepStrictEqual } from "node:util";
import type { Db } from "mongodb";
import { brushStrokes } from "./illustration-brush";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { withDbTransaction } from "./db";
import { placeScenesEnabled } from "./place-scene-enabled";
import { checkedAssetQuote, reserveAssetJob } from "./asset-reservation";
import { assetBackend, assetWorkerAvailable, wireMesh, type MeshAssetDoc, type MeshJobDoc } from "./mesh-execution";
import { meshBytes, meshLibrary, refreshMesh, cancelMesh } from "./mesh-server";
import { illustrationDependency, illustrationEditSource, illustrationSource, keyframeArt, prepareIllustrationInput, prepareKeyframeViewInput } from "./illustration-input";
import { assertCurrentView, fenceViewSources, type PlaceViewDoc } from "./place-view-store";
import type { IllustrationEditInput, IllustrationKeyframeInput, SavedIllustration } from "./place-view";
import { composeIllustrationRegion } from "./illustration-region-server";
import { registeredPixels, selectedObjectIds } from "./illustration-region";
import { ILLUSTRATION_EDIT_MODEL, KEYFRAME_MODEL } from "./asset-pipeline";
import { checkGeometryRefreshBase, composeIllustrationRefresh } from "./illustration-refresh-server";
import { usesIllustrationIdentity } from "./illustration-identity";

async function access(sid: string, viewId: string) {
  if (!isSafeId(viewId)) throw new CreatorError("Invalid camera view", 400);
  const db = await requireCreator(sid);
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${viewId}`, session_id: sid });
  if (!view) throw new CreatorError("Saved camera view not found", 404);
  return { db, view };
}
export function wireIllustration(asset: MeshAssetDoc, view: PlaceViewDoc, historical: boolean): SavedIllustration {
  if (!asset.view_dependency || !asset.request_id) throw new CreatorError("Illustration provenance is missing", 503);
  return { id: asset.id, prompt: asset.prompt, model: asset.model, sha256: asset.sha256, request_id: asset.request_id,
    created_at: asset.created_at.toISOString(), parameters: asset.parameters ?? {}, view_dependency: asset.view_dependency,
    accepted: view.accepted_illustration_id === asset.id, historical, content_type: asset.content_type ?? "image/jpeg",
    ...(asset.region_edit ? { region_edit: asset.region_edit } : {}), ...(asset.edit_input ? { edit_input: asset.edit_input } : {}), ...(asset.geometry_refresh ? { geometry_refresh: asset.geometry_refresh } : {}), ...(asset.keyframe ? { keyframe: asset.keyframe } : {}) };
}
export async function illustrationLibrary(sid: string, viewId: string) {
  const { db, view } = await access(sid, viewId);
  const { capabilities } = await meshLibrary(sid, "illustration");
  let regionCapabilities;
  try {
    regionCapabilities = await assetBackend("illustration", "region-capabilities");
    if (regionCapabilities.model !== ILLUSTRATION_EDIT_MODEL || !Number.isFinite(regionCapabilities.reservation) || regionCapabilities.reservation <= 0) regionCapabilities = { ...regionCapabilities, enabled: false, reason: "Masked generation is not configured." };
    if (regionCapabilities.enabled && !await assetWorkerAvailable(db, "illustration", true, false, false, usesIllustrationIdentity(regionCapabilities.parameters))) regionCapabilities = { ...regionCapabilities, enabled: false, reason: "A compatible masked-generation worker is unavailable." };
  } catch { regionCapabilities = { enabled: false, model: ILLUSTRATION_EDIT_MODEL, reservation: 0, parameters: {}, reason: "Masked generation backend unavailable." }; }
  regionCapabilities.brush_enabled = !!regionCapabilities.enabled && await assetWorkerAvailable(db, "illustration", true, false, true);
  let keyframeCapabilities;
  try {
    keyframeCapabilities = await assetBackend("illustration", "keyframe-capabilities");
    if (keyframeCapabilities.model !== KEYFRAME_MODEL || !Number.isFinite(keyframeCapabilities.reservation) || keyframeCapabilities.reservation <= 0) keyframeCapabilities = { ...keyframeCapabilities, enabled: false, reason: "Keyframe painting is not configured." };
    if (keyframeCapabilities.enabled && !await assetWorkerAvailable(db, "illustration", false, false, false, false, true)) keyframeCapabilities = { ...keyframeCapabilities, enabled: false, reason: "A compatible keyframe worker is unavailable." };
  } catch { keyframeCapabilities = { enabled: false, model: KEYFRAME_MODEL, reservation: 0, parameters: {}, reason: "Keyframe backend unavailable." }; }
  // Cameras of the same place whose accepted artwork a keyframe can continue from.
  const chainSources = (await db.collection<PlaceViewDoc>("place_views").find({ session_id: sid, root_place_id: view.root_place_id, accepted_illustration_id: { $exists: true } }).sort({ created_at: -1 }).limit(50).toArray())
    .filter(v => v.id !== viewId).map(v => ({ view_id: v.id, label: v.label }));
  const jobs = await db.collection<MeshJobDoc>("illustration_jobs").find({ session_id: sid, "view_dependency.view_id": viewId }).sort({ created_at: -1 }).limit(50).toArray();
  const assets = await db.collection<MeshAssetDoc>("illustration_assets").find({ session_id: sid, "view_dependency.view_id": viewId }).sort({ created_at: -1 }).limit(50).toArray();
  let historical = false, reason: string | undefined;
  try {
    const sources = await assertCurrentView(db, view);
    if (sources.some(s => s.definition.material_pack)) reason = "Legacy material packs need immutable atlas bindings before illustration generation.";
  } catch (error) { if (!(error instanceof CreatorError) || error.status !== 409) throw error; historical = true; }
  const blocked = historical ? "Capture the current geometry before generating." : reason ?? (placeScenesEnabled() ? undefined : "World scenes are not enabled.");
  const usable = <T extends object>(config: T) => blocked ? { ...config, enabled: false, reason: blocked } : config;
  return { jobs: jobs.map(wireMesh), assets: assets.map(asset => wireIllustration(asset, view, historical)), historical,
    accepted_id: view.accepted_illustration_id ?? null,
    region_capabilities: usable(regionCapabilities), capabilities: usable(capabilities), keyframe_capabilities: usable(keyframeCapabilities), chain_sources: chainSources };
}
// "Continue from" names another camera of the same place, and its accepted
// artwork is pinned now. Otherwise image 2 is the world's art, or words.
async function keyframeRequest(db: Db, sid: string, view: PlaceViewDoc, chainFrom: string | undefined, art: boolean): Promise<Omit<IllustrationKeyframeInput, "gate_object_id">> {
  if (chainFrom === undefined) {
    const reference = art ? await keyframeArt(db, sid, view.root_place_id) : null;
    return reference ? { stage: "first", art: "art", reference } : { stage: "first", art: "words" };
  }
  const from = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${chainFrom}`, session_id: sid });
  if (!from) throw new CreatorError("The camera to continue from was not found", 404);
  if (from.root_place_id !== view.root_place_id) throw new CreatorError("Continue from a camera of the same place", 409);
  const asset = from.accepted_illustration_id ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${from.accepted_illustration_id}`, session_id: sid }) : null;
  if (!asset) throw new CreatorError("Accept an illustration at that camera before continuing from it", 409);
  return { stage: "chain", chain_from: { view_id: from.id, illustration_id: asset.id, sha256: asset.sha256 } };
}
export async function submitIllustration(sid: string, viewId: string, input: Record<string, unknown>) {
  const { db, view } = await access(sid, viewId);
  if (!isSafeId(input.id) || typeof input.prompt !== "string" || input.prompt.trim().length < 3 || input.prompt.length > 1024 || input.confirmed !== true) throw new CreatorError("An appearance prompt and explicit generation consent are required", 400);
  const id = input.id, prompt = input.prompt.trim(), key = `${sid}:${id}`;
  const region = input.action === "generate_region", keyframe = input.action === "generate_keyframe";
  if ((input.model === ILLUSTRATION_EDIT_MODEL) !== region) throw new CreatorError("Masked generation requires explicit region intent", 400);
  // `art: false` paints from words only; a chained keyframe takes no art.
  if ((input.model === KEYFRAME_MODEL) !== keyframe || !keyframe && (input.chain_from !== undefined || input.art !== undefined)
    || input.chain_from !== undefined && !isSafeId(input.chain_from) || input.art !== undefined && (input.art !== false || input.chain_from !== undefined)) throw new CreatorError("Keyframe painting requires explicit keyframe intent", 400);
  const objectIds = region ? selectedObjectIds(input.object_ids, view.objects) : undefined;
  const strokes = brushStrokes(input.brush_strokes, view.width, view.height);
  if (!region && strokes !== undefined) throw new CreatorError("Brush strokes require explicit masked generation intent", 400);
  if (region && input.base_id !== null && (typeof input.base_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.base_id))) throw new CreatorError("Invalid accepted artwork identity", 400);
  const same = (job: MeshJobDoc) => {
    if (job.view_dependency?.view_id !== viewId || job.prompt !== prompt || job.model !== input.model || job.reservation !== input.reservation || !isDeepStrictEqual(job.parameters, input.parameters)
      || !!job.keyframe_input !== keyframe || keyframe && (job.keyframe_input?.chain_from?.view_id !== input.chain_from || input.art === false && job.keyframe_input?.art !== "words")
      || !!job.edit_input !== region || region && (job.edit_input?.base_id !== input.base_id || !isDeepStrictEqual(job.edit_input?.object_ids, objectIds) || !isDeepStrictEqual(job.edit_input?.brush_strokes, strokes))) throw new CreatorError("Illustration request id already used", 409);
    return { job: wireMesh(job) };
  };
  const previous = await db.collection<MeshJobDoc>("illustration_jobs").findOne({ _id: key });
  if (previous) return same(previous);
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  const dependency = illustrationDependency(view);
  await illustrationSource(db, sid, dependency);
  let edit: IllustrationEditInput | undefined;
  if (region) {
    const base = input.base_id ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${input.base_id}`, session_id: sid }) : null;
    edit = { base_id: input.base_id as string | null, base_sha256: base?.sha256 ?? view.files.render.sha256, mask_sha256: view.files.objects.sha256, object_ids: objectIds!, ...(strokes ? { brush_strokes: strokes } : {}) };
    await illustrationEditSource(db, sid, view, edit);
    // Validate visibility and all owned input bytes before reserving any spend.
    await prepareIllustrationInput(db, sid, dependency, edit);
  }
  let keyframeInput: IllustrationKeyframeInput | undefined;
  if (keyframe) {
    const request = await keyframeRequest(db, sid, view, input.chain_from as string | undefined, input.art !== false);
    // Read and check every pinned input, and choose the gated building, before reserving.
    keyframeInput = { ...request, gate_object_id: (await prepareKeyframeViewInput(db, sid, dependency, { ...request, gate_object_id: null })).gate_object_id };
  }
  const quote = await checkedAssetQuote(db, "illustration", input);
  return withDbTransaction(async (db, session) => {
    const jobs = db.collection<MeshJobDoc>("illustration_jobs"), options = { session };
    const old = await jobs.findOne({ _id: key }, options); if (old) return same(old);
    const current = await illustrationSource(db, sid, dependency, session);
    if (edit) await illustrationEditSource(db, sid, current, edit, session);
    const regionCount = await db.collection<MeshAssetDoc>("illustration_assets").countDocuments({ session_id: sid, "view_dependency.view_id": viewId, $or: [{ region_edit: { $exists: true } }, { geometry_refresh: { $exists: true } }] }, options);
    if (await jobs.countDocuments({ session_id: sid, "view_dependency.view_id": viewId }, options) + regionCount >= 50) throw new CreatorError("This camera view already has 50 illustration requests or edits", 409);
    await fenceViewSources(db, current, session);
    const job = await reserveAssetJob(db, session, sid, "illustration", id, prompt, quote, undefined, dependency);
    if (edit) await jobs.updateOne({ _id: job._id }, { $set: { edit_input: edit } }, options);
    if (keyframeInput) await jobs.updateOne({ _id: job._id }, { $set: { keyframe_input: keyframeInput } }, options);
    return { job: wireMesh(job) };
  });
}
export async function illustrationAction(sid: string, viewId: string, input: Record<string, unknown>) {
  if (input.action === "generate" || input.action === "generate_region" || input.action === "generate_keyframe") return submitIllustration(sid, viewId, input);
  const { db, view: savedView } = await access(sid, viewId);
  if (input.action === "compose") return composeIllustrationRegion(db, sid, savedView, input);
  if (input.action === "compose_refresh") return composeIllustrationRefresh(db, sid, savedView, input);
  if (input.action === "refresh" || input.action === "cancel") {
    if (!isSafeId(input.id) || !await db.collection<MeshJobDoc>("illustration_jobs").findOne({ _id: `${sid}:${input.id}`, "view_dependency.view_id": viewId })) throw new CreatorError("Illustration job not found", 404);
    return input.action === "refresh" ? refreshMesh(sid, input.id, "illustration") : cancelMesh(sid, input.id, "illustration");
  }
  if (input.action !== "accept" || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.id)
    || input.previous_id !== null && (typeof input.previous_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.previous_id))) throw new CreatorError("Invalid illustration action", 400);
  // Verify bytes before the transaction. Asset records/bytes are immutable;
  // acceptance below checks the same owned identity and current scene bindings.
  const id = input.id;
  await registeredPixels(await meshBytes(sid, id, "illustration"), savedView.width, savedView.height);
  return withDbTransaction(async (db, session) => {
    const options = { session }, views = db.collection<PlaceViewDoc>("place_views");
    const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
    if (!asset?.view_dependency || asset.view_dependency.view_id !== viewId) throw new CreatorError("Illustration does not belong to this camera view", 409);
    if (asset.edit_input) throw new CreatorError("Preview the protected region composite before accepting a masked model result", 409);
    const view = await illustrationSource(db, sid, asset.view_dependency, session);
    if (view.accepted_illustration_id !== id && (view.accepted_illustration_id ?? null) !== input.previous_id) throw new CreatorError("Accepted illustration changed. Review the saved selection.", 409);
    if (asset.region_edit && view.accepted_illustration_id !== id && asset.region_edit.base_id !== (view.accepted_illustration_id ?? null)) throw new CreatorError("This region edit uses older accepted artwork. Preview it again on the current base.", 409);
    if (asset.geometry_refresh) {
      if (view.accepted_illustration_id !== id && asset.geometry_refresh.previous_id !== (view.accepted_illustration_id ?? null)) throw new CreatorError("This artwork refresh uses an older destination selection", 409);
      await checkGeometryRefreshBase(db, sid, view, asset.geometry_refresh, session);
    }
    await fenceViewSources(db, view, session);
    await views.updateOne({ _id: view._id }, { $set: { accepted_illustration_id: id } }, options);
    return { accepted_id: id };
  });
}
