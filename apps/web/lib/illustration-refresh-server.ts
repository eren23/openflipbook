import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator-error";
import { withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { getStoredBytes, uploadJpeg } from "./r2";
import { illustrationDependency, illustrationSource } from "./illustration-input";
import { fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import type { MeshAssetDoc } from "./mesh-execution";
import { assertRefreshCamera, composeGeometryRefresh } from "./illustration-refresh";
import { pixelBytesHash } from "./illustration-region";
import { VIEW_PASSES, type IllustrationGeometryRefresh, type ViewPass } from "./place-view";

const assetId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v);
async function bytes(file: { key: string; sha256: string; bytes: number }) {
  const saved = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!saved || saved.bytes.length !== file.bytes || pixelBytesHash(saved.bytes) !== file.sha256) throw new CreatorError("Saved artwork refresh input is missing or corrupted", 503);
  return saved.bytes;
}
async function baseSource(db: Db, sid: string, view: PlaceViewDoc, baseId: string | null, session?: ClientSession) {
  const options = session ? { session } : {};
  const before = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${view.refreshed_from}`, session_id: sid }, options);
  if (!before) throw new CreatorError("The saved predecessor view is unavailable", 409);
  assertRefreshCamera(before, view);
  if ((before.accepted_illustration_id ?? null) !== baseId) throw new CreatorError("Previous artwork changed; reload the saved views", 409);
  const base = baseId ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${baseId}`, session_id: sid }, options) : null;
  if (baseId && (!base?.view_dependency || viewHash(base.view_dependency) !== viewHash(illustrationDependency(before)))) throw new CreatorError("Previous artwork does not belong to the predecessor camera", 409);
  return { before, file: base ?? before.files.render };
}
export async function checkGeometryRefreshBase(db: Db, sid: string, view: PlaceViewDoc, refresh: IllustrationGeometryRefresh, session?: ClientSession) {
  const base = await baseSource(db, sid, view, refresh.base_id, session);
  if (viewHash(illustrationDependency(base.before)) !== viewHash(refresh.base_view) || base.file.sha256 !== refresh.base_sha256) throw new CreatorError("Artwork refresh predecessor changed", 409);
}

// A local, lossless preview. Generating the proposal and accepting this artifact
// are separate explicit actions; neither world geometry nor old artwork changes.
export async function composeIllustrationRefresh(db: Db, sid: string, view: PlaceViewDoc, input: Record<string, unknown>) {
  if (!isSafeId(input.id) || !assetId(input.proposal_id) || input.base_id !== null && !assetId(input.base_id)
    || input.previous_id !== null && !assetId(input.previous_id)) throw new CreatorError("Invalid artwork refresh identity", 400);
  const id = `refresh_${input.id}`, key = `${sid}:${id}`, proposalId = input.proposal_id, baseId = input.base_id as string | null, previousId = input.previous_id as string | null;
  const dependency = illustrationDependency(view), requestHash = viewHash({ dependency, proposalId, baseId, previousId });
  const same = (asset: MeshAssetDoc) => {
    if (asset.geometry_refresh?.request_sha256 !== requestHash) throw new CreatorError("Artwork refresh request id already used", 409);
    return { id: asset.id };
  };
  const old = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: key }); if (old) return same(old);
  async function inputs(db: Db, session?: ClientSession) {
    const options = session ? { session } : {}, current = await illustrationSource(db, sid, dependency, session);
    if ((current.accepted_illustration_id ?? null) !== previousId) throw new CreatorError("Accepted destination artwork changed", 409);
    const base = await baseSource(db, sid, current, baseId, session);
    const proposal = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${proposalId}`, session_id: sid }, options);
    if (!proposal?.view_dependency || viewHash(proposal.view_dependency) !== viewHash(dependency) || proposal.edit_input || proposal.region_edit || proposal.geometry_refresh || !proposal.request_id) throw new CreatorError("Refresh needs a full generated proposal for the current saved camera", 409);
    const scope = { session_id: sid, "view_dependency.view_id": view.id };
    const jobs = await db.collection("illustration_jobs").countDocuments(scope, options);
    const edits = await db.collection("illustration_assets").countDocuments({ ...scope, $or: [{ region_edit: { $exists: true } }, { geometry_refresh: { $exists: true } }] }, options);
    if (jobs + edits >= 50) throw new CreatorError("This camera view already has 50 illustration requests or edits", 409);
    return { current, ...base, proposal };
  }
  const source = await inputs(db), oldPasses = {} as Record<ViewPass, Buffer>, newPasses = {} as Record<ViewPass, Buffer>;
  for (const pass of VIEW_PASSES) { oldPasses[pass] = await bytes(source.before.files[pass]); newPasses[pass] = await bytes(source.current.files[pass]); }
  const result = await composeGeometryRefresh(await bytes(source.file), await bytes(source.proposal), source.before, source.current, oldPasses, newPasses);
  const sha256 = pixelBytesHash(result.bytes), storageKey = `${sid}/illustrations/${id}/${sha256}.png`;
  const geometry_refresh: IllustrationGeometryRefresh = { version: 1, method: "registered_render_delta_rgba_v1", padding_px: 2,
    request_sha256: requestHash, proposal_id: proposalId, proposal_sha256: source.proposal.sha256,
    base_view: illustrationDependency(source.before), base_id: baseId, base_sha256: source.file.sha256, previous_id: previousId,
    mask_sha256: result.mask_sha256, changed_pixels: result.changed_pixels, protected_pixels: result.protected_pixels };
  await uploadJpeg(storageKey, result.bytes, "image/png", AbortSignal.timeout(90_000));
  return withDbTransaction(async (db, session) => {
    const assets = db.collection<MeshAssetDoc>("illustration_assets"), options = { session };
    const old = await assets.findOne({ _id: key }, options); if (old) return same(old);
    const checked = await inputs(db, session);
    await checkGeometryRefreshBase(db, sid, checked.current, geometry_refresh, session);
    if (checked.proposal.sha256 !== source.proposal.sha256) throw new CreatorError("Artwork refresh proposal changed", 409);
    await fenceViewSources(db, checked.current, session);
    await assets.insertOne({ _id: key, id, session_id: sid, key: storageKey, sha256, bytes: result.bytes.length, content_type: "image/png",
      model: source.proposal.model, prompt: source.proposal.prompt, request_id: source.proposal.request_id!, created_at: new Date(),
      parameters: source.proposal.parameters ?? {}, view_dependency: dependency, geometry_refresh,
      illustration: { width: view.width, height: view.height, color_space: "srgb" } }, options);
    return { id };
  });
}
