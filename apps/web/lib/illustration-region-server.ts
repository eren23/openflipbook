import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator-error";
import { withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { getStoredBytes, uploadJpeg } from "./r2";
import { illustrationDependency, illustrationSource } from "./illustration-input";
import { fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import type { MeshAssetDoc } from "./mesh-execution";
import { isDeepStrictEqual } from "node:util";
import { brushStrokes } from "./illustration-brush";
import { composeRegisteredObjects, pixelBytesHash, selectedObjectIds } from "./illustration-region";

const assetId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v);
async function fileBytes(file: { key: string; sha256: string; bytes: number }) {
  const saved = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!saved || saved.bytes.length !== file.bytes || pixelBytesHash(saved.bytes) !== file.sha256) throw new CreatorError("Saved region-edit input is missing or corrupted", 503);
  return saved.bytes;
}

// The caller has established ownership. This path performs no provider calls and
// never modifies the accepted pointer; the user must review the composite first.
export async function composeIllustrationRegion(db: Db, sid: string, view: PlaceViewDoc, input: Record<string, unknown>) {
  if (!isSafeId(input.id) || !assetId(input.proposal_id) || input.base_id !== null && !assetId(input.base_id)) throw new CreatorError("Invalid region-edit identity", 400);
  const id = `region_${input.id}`, proposalId = input.proposal_id, baseId = input.base_id as string | null;
  const ids = selectedObjectIds(input.object_ids, view.objects), dependency = illustrationDependency(view);
  const strokes = brushStrokes(input.brush_strokes, view.width, view.height);
  const brush = strokes ? { brush_strokes: strokes } : {};
  const requestHash = viewHash({ dependency, proposal_id: proposalId, base_id: baseId, object_ids: ids, ...brush });
  const key = `${sid}:${id}`, assets = db.collection<MeshAssetDoc>("illustration_assets");
  const same = (asset: MeshAssetDoc) => {
    if (asset.region_edit?.request_sha256 !== requestHash) throw new CreatorError("Region-edit request id already used", 409);
    return { id: asset.id };
  };
  const old = await assets.findOne({ _id: key }); if (old) return same(old);
  async function checkCapacity(db: Db, session?: ClientSession) {
    const scope = { session_id: sid, "view_dependency.view_id": view.id }, options = session ? { session } : {};
    const jobs = await db.collection("illustration_jobs").countDocuments(scope, options);
    const edits = await db.collection("illustration_assets").countDocuments({ ...scope, $or: [{ region_edit: { $exists: true } }, { geometry_refresh: { $exists: true } }] }, options);
    if (jobs + edits >= 50) throw new CreatorError("This camera view already has 50 illustration requests or edits", 409);
  }
  async function inputs(db: Db, session?: ClientSession) {
    const current = await illustrationSource(db, sid, dependency, session), options = session ? { session } : {};
    if ((current.accepted_illustration_id ?? null) !== baseId) throw new CreatorError("Accepted artwork changed. Review the new base before editing.", 409);
    const collection = db.collection<MeshAssetDoc>("illustration_assets");
    const proposal = await collection.findOne({ _id: `${sid}:${proposalId}`, session_id: sid }, options);
    const base = baseId ? await collection.findOne({ _id: `${sid}:${baseId}`, session_id: sid }, options) : null;
    if (!proposal || baseId && !base || [proposal, ...(base ? [base] : [])].some(a => !a.view_dependency || viewHash(a.view_dependency) !== viewHash(dependency))) throw new CreatorError("Region-edit images must belong to this exact saved camera", 409);
    if (proposal.edit_input && (proposal.edit_input.base_id !== baseId || proposal.edit_input.base_sha256 !== (base ?? view.files.render).sha256
      || ids.some(id => !proposal.edit_input!.object_ids.includes(id)) || proposal.edit_input.brush_strokes !== undefined && !isDeepStrictEqual(proposal.edit_input.brush_strokes, strokes))) throw new CreatorError("Masked proposal was generated for different artwork, objects or brush strokes", 409);
    return { current, proposal, base };
  }
  const source = await inputs(db);
  const requestId = source.proposal.request_id;
  if (!requestId) throw new CreatorError("Illustration provider provenance is missing", 503);
  await checkCapacity(db);
  const baseFile = source.base ?? view.files.render;
  const result = await composeRegisteredObjects(await fileBytes(baseFile), await fileBytes(source.proposal), await fileBytes(view.files.objects), view, ids, strokes);
  const sha256 = pixelBytesHash(result.bytes), storageKey = `${sid}/illustrations/${id}/${sha256}.png`;
  await uploadJpeg(storageKey, result.bytes, "image/png", AbortSignal.timeout(90_000));
  return withDbTransaction(async (db, session) => {
    const collection = db.collection<MeshAssetDoc>("illustration_assets"), options = { session };
    const existing = await collection.findOne({ _id: key }, options); if (existing) return same(existing);
    const checked = await inputs(db, session);
    if (checked.proposal.sha256 !== source.proposal.sha256 || (checked.base?.sha256 ?? view.files.render.sha256) !== baseFile.sha256) throw new CreatorError("Region-edit input changed", 409);
    await checkCapacity(db, session);
    await fenceViewSources(db, checked.current, session);
    await collection.insertOne({ _id: key, id, session_id: sid, key: storageKey, sha256, bytes: result.bytes.length, content_type: "image/png",
      model: source.proposal.model, prompt: source.proposal.prompt, request_id: requestId, created_at: new Date(),
      parameters: source.proposal.parameters ?? {}, view_dependency: dependency,
      illustration: { width: view.width, height: view.height, color_space: "srgb" },
      region_edit: { version: 1, request_sha256: requestHash, proposal_id: proposalId, proposal_sha256: source.proposal.sha256,
        base_id: baseId, base_sha256: baseFile.sha256, object_ids: ids, mask_sha256: view.files.objects.sha256,
        ...brush, selected_pixels: result.selected_pixels, protected_pixels: result.protected_pixels, method: strokes ? "object_clipped_brush_rgba_v1" : "exact_object_mask_rgba_v1" },
    }, options);
    return { id };
  });
}
