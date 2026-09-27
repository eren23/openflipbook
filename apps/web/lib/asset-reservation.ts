import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator";
import { assetPipeline, ILLUSTRATION_EDIT_MODEL, type AssetKind, type AssetQuote } from "./asset-pipeline";
import { assetBackend, assetWorkerAvailable, type MeshJobDoc } from "./mesh-execution";
import { MESH_IMAGE_MODEL } from "./mesh-asset";
import { reserveGenerationSpend } from "./generation-reservation";
import { usesIllustrationIdentity } from "./illustration-identity";

export type { AssetQuote } from "./asset-pipeline";
export async function cancelReservedAsset(db: Db, session: ClientSession, sid: string, kind: AssetKind, id: string) {
  const jobs = db.collection<MeshJobDoc>(`${kind}_jobs`), options = { session };
  const job = await jobs.findOne({ _id: `${sid}:${id}` }, options);
  if (!job) throw new CreatorError("Asset job not found", 404);
  if (job.status === "cancelled") return job;
  if (["ready", "failed"].includes(job.status)) throw new CreatorError("This asset job can no longer be cancelled", 409);
  if (job.status === "scheduled") for (const ledgerId of job.ledger_ids ?? []) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: ledgerId }, { $inc: { total: -job.reservation } }, options);
  const error = job.status === "scheduled" ? "Cancelled before submission; reservation released." : "Result discarded. Provider work may remain billable; reservation retained.";
  await jobs.updateOne({ _id: job._id }, { $set: { status: "cancelled", error } }, options);
  return { ...job, status: "cancelled" as const, error };
}
export async function checkedAssetQuote(db: Db, kind: AssetKind, input: Record<string, unknown>): Promise<AssetQuote> {
  let config;
  const region = kind === "illustration" && input.model === ILLUSTRATION_EDIT_MODEL;
  const image = kind === "mesh" && input.model === MESH_IMAGE_MODEL;
  try { config = await assetBackend(kind, region ? "region-capabilities" : image ? "image-capabilities" : "capabilities"); } catch { throw new CreatorError("Asset generation backend unavailable", 503); }
  if (!config.enabled || !Number.isFinite(config.reservation) || config.reservation <= 0 || config.reservation > 10
    || config.model !== (region ? ILLUSTRATION_EDIT_MODEL : image ? MESH_IMAGE_MODEL : assetPipeline(kind).model) || !config.parameters || typeof config.parameters !== "object" || Array.isArray(config.parameters)) throw new CreatorError("Asset generation is not enabled", 503);
  if (input.reservation !== config.reservation || input.model !== undefined && input.model !== config.model
    || input.parameters !== undefined && !isDeepStrictEqual(input.parameters, config.parameters)) throw new CreatorError("Generation configuration changed. Review the new reservation.", 409);
  if (!await assetWorkerAvailable(db, kind, region, image, region && input.brush_strokes !== undefined, kind === "illustration" && usesIllustrationIdentity(config.parameters))) throw new CreatorError("Compatible asset worker or storage unavailable. No reservation created.", 503);
  return { model: config.model, reservation: config.reservation, parameters: config.parameters };
}

// Caller owns the transaction and authorization. This lets a dependent batch and
// all its reservations commit together, without nested transactions or network I/O.
export async function reserveAssetJob(db: Db, session: ClientSession, sid: string, kind: AssetKind, id: string, prompt: string, quote: AssetQuote, dependency?: MeshJobDoc["dependency"], viewDependency?: MeshJobDoc["view_dependency"], imageInput?: MeshJobDoc["image_input"]): Promise<MeshJobDoc> {
  const spec = assetPipeline(kind), options = { session };
  const now = new Date(), ledgerIds = await reserveGenerationSpend(db, session, sid, kind, quote.reservation, spec.cap, now);
  const job: MeshJobDoc = { _id: `${sid}:${id}`, id, session_id: sid, prompt, ...quote,
    status: "scheduled", created_at: now, ledger_ids: ledgerIds, ...(dependency ? { dependency } : {}), ...(viewDependency ? { view_dependency: viewDependency } : {}), ...(imageInput ? { image_input: imageInput, source_id: imageInput.id } : {}) };
  await db.collection<MeshJobDoc>(`${kind}_jobs`).insertOne(job, options);
  return job;
}
