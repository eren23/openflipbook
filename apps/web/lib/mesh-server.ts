import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireCreator, CreatorError } from "./creator";
import { withDbTransaction } from "./db";
import { getStoredBytes } from "./r2";
import { isSafeId } from "./ids";
import { MESH_IMAGE_MODEL } from "./mesh-asset";
import { readMeshSource } from "./mesh-source";
import { assetPipeline, type AssetKind, type BuildAssetKind } from "./asset-pipeline";
import { savedMeshDimensions } from "./mesh-geometry-server";
import { checkedAssetQuote, reserveAssetJob, cancelReservedAsset } from "./asset-reservation";
import { expireAssetSubmissions, assetBackend, assetWorkerAvailable, wireMesh, type MeshJobDoc, type MeshAssetDoc } from "./mesh-execution";
import { usesIllustrationIdentity } from "./illustration-identity";
export type { MeshAssetDoc } from "./mesh-execution";

export async function meshDimensions(sid: string, id: string) {
  return savedMeshDimensions(await requireCreator(sid), sid, id);
}

export async function meshLibrary(sid: string, kind: AssetKind = "mesh") {
  const db = await requireCreator(sid);
  await expireAssetSubmissions(db, kind, sid);
  const jobs = await db.collection<MeshJobDoc>(`${kind}_jobs`).find({ session_id: sid }).sort({ created_at: -1 }).limit(30).toArray();
  let capabilities;
  try {
    capabilities = await assetBackend(kind, "capabilities");
    if (capabilities.enabled && !await assetWorkerAvailable(db, kind, false, false, false, kind === "illustration" && usesIllustrationIdentity(capabilities.parameters))) capabilities = { ...capabilities, enabled: false, reason: "Compatible asset worker or storage unavailable. Saved jobs are retained." };
  } catch { capabilities = { enabled: false, model: assetPipeline(kind).model, reservation: 0, reason: "Asset generation backend unavailable" }; }
  const assets = kind === "material" ? (await db.collection<MeshAssetDoc>("material_assets").find({ session_id: sid }).sort({ created_at: -1 }).limit(200).toArray())
    .map(asset => ({ id: asset.id, prompt: asset.prompt, model: asset.model, sha256: asset.sha256, image: asset.image })) : [];
  const saved_meshes = kind === "mesh" ? (await db.collection<MeshAssetDoc>("mesh_assets").find({ session_id: sid }).sort({ created_at: -1 }).limit(200).toArray())
    .map(asset => ({ id: asset.id, prompt: asset.prompt, model: asset.model, sha256: asset.sha256, ...(asset.imported ? { imported: asset.imported } : {}), ...(asset.image_input ? { source_id: asset.image_input.id } : {}) })) : [];
  let image_capabilities;
  if (kind === "mesh") {
    try {
      image_capabilities = await assetBackend(kind, "image-capabilities");
      if (image_capabilities.model !== MESH_IMAGE_MODEL || !await assetWorkerAvailable(db, kind, false, true)) image_capabilities = { ...image_capabilities, enabled: false, reason: "Image mesh worker unavailable. Restart the asset worker after upgrading." };
    } catch { image_capabilities = { enabled: false, model: MESH_IMAGE_MODEL, reservation: 0, reason: "Image mesh generation backend unavailable" }; }
  }
  return { jobs: jobs.map(wireMesh), capabilities, assets, ...(kind === "mesh" ? { saved_meshes } : {}), ...(image_capabilities ? { image_capabilities } : {}) };
}

export async function submitMesh(sid: string, input: Record<string, unknown>, kind: BuildAssetKind = "mesh") {
  const db = await requireCreator(sid);
  if (!isSafeId(input.id) || typeof input.prompt !== "string" || input.prompt.trim().length < 3 || input.prompt.length > 1024 || input.confirmed !== true) throw new CreatorError("A prompt and generation consent are required", 400);
  const id = input.id, prompt = input.prompt.trim(), key = `${sid}:${id}`, col = db.collection<MeshJobDoc>(`${kind}_jobs`);
  const image = kind === "mesh" && input.model === MESH_IMAGE_MODEL;
  if (image !== (typeof input.source_id === "string") || !image && input.source_id !== undefined) throw new CreatorError("Image generation requires a saved concept and the image model", 400);
  const same = (job: MeshJobDoc) => {
    if (job.prompt !== prompt || job.reservation !== input.reservation || (input.model !== undefined && job.model !== input.model)
      || job.source_id !== input.source_id || (input.parameters !== undefined && !isDeepStrictEqual(job.parameters, input.parameters))) throw new CreatorError("Request id already used", 409);
    return { job: wireMesh(job) };
  };
  const old = await col.findOne({ _id: key }); if (old) return same(old);
  const config = await checkedAssetQuote(db, kind, input);
  const source = image ? await readMeshSource(db, sid, input.source_id) : undefined;
  return withDbTransaction(async (db, session) => {
    const jobs = db.collection<MeshJobDoc>(`${kind}_jobs`), options = { session };
    const previous = await jobs.findOne({ _id: key }, options); if (previous) return same(previous);
    return { job: wireMesh(await reserveAssetJob(db, session, sid, kind, id, prompt, config, undefined, undefined, source)) };
  });
}

export async function refreshMesh(sid: string, id: unknown, kind: AssetKind = "mesh") {
  const db = await requireCreator(sid); if (!isSafeId(id)) throw new CreatorError("Invalid mesh job", 400);
  await expireAssetSubmissions(db, kind, sid);
  const col = db.collection<MeshJobDoc>(`${kind}_jobs`), key = `${sid}:${id}`;
  const job = await col.findOne({ _id: key }); if (!job) throw new CreatorError("Mesh job not found", 404);
  // Refresh only schedules a read or retries storage, never model generation.
  if (job.request_id && ["queued", "running", "storage_failed", "submission_unknown"].includes(job.status)) {
    await col.updateOne({ _id: key, status: job.status }, { $set: { next_check: new Date(), ...(job.status === "storage_failed" ? { status: "queued" as const, refresh_result: true } : {}) }, $unset: { error: "" } });
  }
  return { job: wireMesh((await col.findOne({ _id: key }))!) };
}

export async function cancelMesh(sid: string, id: unknown, kind: AssetKind = "mesh") {
  await requireCreator(sid); if (!isSafeId(id)) throw new CreatorError("Invalid mesh job", 400);
  return withDbTransaction(async (db, session) => {
    return { job: wireMesh(await cancelReservedAsset(db, session, sid, kind, id)) };
  });
}

export async function meshBytes(sid: string, id: string, kind: AssetKind = "mesh") {
  const db = await requireCreator(sid);
  // Asset IDs add a prefix to a valid request ID; use the scene asset limit.
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new CreatorError("Invalid mesh id", 400);
  const asset = await db.collection<MeshAssetDoc>(`${kind}_assets`).findOne({ _id: `${sid}:${id}` });
  if (!asset) throw new CreatorError("Mesh not found", 404);
  const stored = await getStoredBytes(asset.key);
  if (!stored || createHash("sha256").update(stored.bytes).digest("hex") !== asset.sha256) throw new CreatorError("Saved mesh is missing or corrupted", 503);
  return stored.bytes;
}
