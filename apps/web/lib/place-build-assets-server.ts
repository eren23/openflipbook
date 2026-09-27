import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { CreatorError, requireCreator } from "./creator";
import { requireBuildConnections } from "./place-build-connections";
import { withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { placeScenesEnabled } from "./place-scene-enabled";
import { buildInputHash, type BuildDoc } from "./place-build-execution";
import { checkedAssetQuote, reserveAssetJob, cancelReservedAsset, type AssetQuote } from "./asset-reservation";
import { wireMesh, type MeshAssetDoc, type MeshJobDoc } from "./mesh-execution";
import { bindPlannedMaterials, type BuildMaterialStage } from "./place-build-materials";
import { refreshMesh } from "./mesh-server";
import type { SceneDoc } from "./place-scene-store";
import { assetPipeline, type BuildAssetKind as AssetKind } from "./asset-pipeline";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import { savedMeshDimensions } from "./mesh-geometry-server";
import { bindPlannedMeshes } from "./place-build-meshes";

export interface BuildAssetDoc {
  _id: string; session_id: string; place_id: string; build_id: string;
  id: string; quote: AssetQuote; result_sha256: string; plan_sha256: string;
  reservation: number; cancelled: boolean; created_at: Date;
  items: { plan_id: string; job_id: string }[];
  replacements: { id: string; plan_id: string; job_id: string; quote: AssetQuote }[];
  kind?: AssetKind;
  appearance?: { kinds: AssetKind[]; total_reservation: number };
}
const plans = (build: BuildDoc, kind: AssetKind) => kind === "mesh" ? build.mesh_plan : build.material_plan;
const stageKey = (buildKey: string, kind: AssetKind) => kind === "mesh" ? `${buildKey}:mesh` : buildKey;
async function access(sid: string, pid: string, id: unknown) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(pid) || !isSafeId(id)) throw new CreatorError("Invalid build identity", 400);
  return requireCreator(sid);
}
function consent(input: Record<string, unknown>) {
  if (input.confirmed !== true || !isSafeId(input.request_id) || typeof input.model !== "string" || !input.parameters) throw new CreatorError("Explicit asset reservation consent is required", 400);
}
function sameQuote(quote: AssetQuote, input: Record<string, unknown>) {
  if (quote.model !== input.model || quote.reservation !== input.reservation || !isDeepStrictEqual(quote.parameters, input.parameters)) throw new CreatorError("Asset request identity already used", 409);
}
async function currentBuild(db: Db, sid: string, pid: string, id: string, session: ClientSession, kind: AssetKind) {
  const options = { session };
  const build = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: `${sid}:${pid}:${id}`, session_id: sid }, options);
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}` }, options);
  if (!build?.result || build.status !== "ready" || !plans(build, kind)?.length || !scene
    || scene.revision !== build.base_revision || buildInputHash(scene.definition) !== build.input_sha256) throw new CreatorError("Build source changed or no accepted asset plan is available", 409);
  await requireBuildConnections(db, build, session);
  return build;
}

export async function readBuildAssetStage(db: Db, build: BuildDoc, kind: AssetKind): Promise<BuildMaterialStage | undefined> {
  const plan = plans(build, kind);
  const stage = await db.collection<BuildAssetDoc>("place_build_assets").findOne({ _id: stageKey(build._id, kind), session_id: build.session_id });
  if (!stage) return undefined;
  const jobs = await db.collection<MeshJobDoc>(`${kind}_jobs`).find({ session_id: build.session_id, id: { $in: stage.items.map(i => i.job_id) } }).toArray();
  const items = stage.items.map(item => {
    const job = jobs.find(j => j.id === item.job_id);
    return { plan_id: item.plan_id, job: job ? wireMesh(job) : { id: item.job_id, prompt: "Missing saved asset job", model: stage.quote.model, reservation: 0, status: "failed" as const, error: "Saved job is missing; no automatic regeneration." } };
  });
  const invalid = !build.result || !plan || (stage.kind ?? "material") !== kind || buildInputHash(build.result) !== stage.result_sha256 || buildInputHash(plan) !== stage.plan_sha256
    || stage.items.length !== plan?.length || new Set(stage.items.map(i => i.plan_id)).size !== stage.items.length
    || stage.items.some(i => !plan?.some(p => p.id === i.plan_id));
  const status = stage.cancelled ? "cancelled" : invalid || items.some(i => ["failed", "cancelled", "storage_failed", "submission_unknown"].includes(i.job.status)) ? "blocked"
    : items.every(i => i.job.status === "ready") ? "ready" : "generating";
  return { id: stage.id, status, reservation: stage.reservation, items };
}

export async function queueBuildAssets(sid: string, pid: string, id: unknown, input: Record<string, unknown>, kind: AssetKind) {
  const db = await access(sid, pid, id); consent(input);
  const key = stageKey(`${sid}:${pid}:${id}`, kind), stages = db.collection<BuildAssetDoc>("place_build_assets");
  const same = (stage: BuildAssetDoc) => {
    if (stage.id !== input.request_id) throw new CreatorError("This build already has this asset stage", 409);
    sameQuote(stage.quote, input);
    return { stage_id: stage.id };
  };
  const previous = await stages.findOne({ _id: key }); if (previous) return same(previous);
  const quote = await checkedAssetQuote(db, kind, input);
  return withDbTransaction(async (db, session) => {
    const col = db.collection<BuildAssetDoc>("place_build_assets"), options = { session };
    const old = await col.findOne({ _id: key }, options); if (old) return same(old);
    const build = await currentBuild(db, sid, pid, id as string, session, kind);
    const stage = await reserveBuildStage(db, session, build, kind, input.request_id as string, quote);
    return { stage_id: stage.id };
  });
}

async function reserveBuildStage(db: Db, session: ClientSession, build: BuildDoc, kind: AssetKind, id: string, quote: AssetQuote, appearance?: BuildAssetDoc["appearance"]) {
  const sid = build.session_id, pid = build.place_id, plan = plans(build, kind)!;
  const result_sha256 = buildInputHash(build.result), plan_sha256 = buildInputHash(plan), items: BuildAssetDoc["items"] = [];
  for (const item of plan) {
    const job = await reserveAssetJob(db, session, sid, kind, randomUUID(), item.prompt, quote,
      { kind, place_id: pid, revision: build.base_revision, input_sha256: build.input_sha256, build_key: build._id, result_sha256, plan_sha256, ...(build.connections_sha256 ? { connections_sha256: build.connections_sha256 } : {}) });
    items.push({ plan_id: item.id, job_id: job.id });
  }
  const stage: BuildAssetDoc = { _id: stageKey(build._id, kind), session_id: sid, place_id: pid, build_id: build.id, id, quote,
    kind, result_sha256, plan_sha256, reservation: quote.reservation * items.length,
    cancelled: false, created_at: new Date(), items, replacements: [], ...(appearance ? { appearance } : {}) };
  await db.collection<BuildAssetDoc>("place_build_assets").insertOne(stage, { session });
  return stage;
}

export async function queueBuildAppearance(sid: string, pid: string, id: unknown, input: Record<string, unknown>) {
  const db = await access(sid, pid, id), allKinds: AssetKind[] = ["material", "mesh"];
  if (input.confirmed !== true || !isSafeId(input.request_id) || typeof input.total_reservation !== "number" || !Number.isFinite(input.total_reservation) || input.total_reservation <= 0 || input.total_reservation > 180
    || !input.quotes || typeof input.quotes !== "object" || Array.isArray(input.quotes) || Object.keys(input.quotes).some(k => !allKinds.includes(k as AssetKind))) throw new CreatorError("Explicit appearance quotes and total reservation are required", 400);
  const quotes = input.quotes as Partial<Record<AssetKind, Record<string, unknown>>>, kinds = allKinds.filter(k => quotes[k] !== undefined);
  if (!kinds.length) throw new CreatorError("No appearance quotes provided", 400);
  for (const kind of kinds) {
    const quote = quotes[kind];
    if (!quote || typeof quote !== "object" || Array.isArray(quote) || quote.model !== assetPipeline(kind).model) throw new CreatorError("Invalid text-generated appearance quote", 400);
    consent({ ...quote, request_id: input.request_id, confirmed: true });
  }
  const buildKey = `${sid}:${pid}:${id}`, requestId = input.request_id;
  const readStages = async (db: Db, session: ClientSession) => {
    const stages = [];
    for (const kind of allKinds) stages.push(await db.collection<BuildAssetDoc>("place_build_assets").findOne({ _id: stageKey(buildKey, kind) }, { session }));
    return stages;
  };
  const replay = (build: BuildDoc | null, stages: (BuildAssetDoc | null)[]) => {
    const approval = build?.appearance_approval;
    const matches = stages.filter(s => s?.id === requestId);
    if (!approval) {
      if (matches.length) throw new CreatorError("Appearance request identity already used", 409);
      return null;
    }
    if (approval.id !== requestId || !isDeepStrictEqual(approval.kinds, kinds) || approval.total_reservation !== input.total_reservation) throw new CreatorError("This build already has an appearance approval", 409);
    for (const kind of kinds) {
      if (!approval.quotes[kind]) throw new CreatorError("Saved appearance approval is incomplete", 409);
      sameQuote(approval.quotes[kind]!, quotes[kind]!);
    }
    if (matches.length !== kinds.length) throw new CreatorError("Appearance approval is incomplete or this request identity is already used", 409);
    for (const kind of kinds) {
      const stage = stages[allKinds.indexOf(kind)];
      if (!stage || stage.id !== requestId || !isDeepStrictEqual(stage.appearance?.kinds, kinds) || stage.appearance?.total_reservation !== input.total_reservation) throw new CreatorError("Appearance request identity already used", 409);
      sameQuote(stage.quote, quotes[kind]!);
    }
    return { stage_ids: Object.fromEntries(kinds.map(kind => [kind, requestId])), reservation: input.total_reservation };
  };
  // Recover a committed approval before checking live configuration. Missing
  // stage records are conflicts, never permission to regenerate their children.
  const previous = await withDbTransaction(async (db, session) => replay(await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: buildKey }, { session }), await readStages(db, session))); if (previous) return previous;
  const checked: Partial<Record<AssetKind, AssetQuote>> = {};
  for (const kind of kinds) checked[kind] = await checkedAssetQuote(db, kind, quotes[kind]!);
  return withDbTransaction(async (db, session) => {
    const stages = await readStages(db, session), old = replay(await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: buildKey }, { session }), stages); if (old) return old;
    const build = await currentBuild(db, sid, pid, id as string, session, kinds[0]!);
    const remaining = allKinds.filter((kind, i) => plans(build, kind)?.length && !stages[i]);
    if (!isDeepStrictEqual(kinds, remaining)) throw new CreatorError("Appearance stages changed. Review the remaining asset reservation.", 409);
    const total = kinds.reduce((sum, kind) => sum + checked[kind]!.reservation * plans(build, kind)!.length, 0);
    if (input.total_reservation !== total) throw new CreatorError("Appearance total changed. Review the complete reservation.", 409);
    for (const kind of kinds) await reserveBuildStage(db, session, build, kind, requestId, checked[kind]!, { kinds, total_reservation: total });
    await db.collection<BuildDoc>("place_build_jobs").updateOne({ _id: buildKey }, { $set: { appearance_approval: { id: requestId, kinds, total_reservation: total, quotes: checked } } }, { session });
    return { stage_ids: Object.fromEntries(kinds.map(kind => [kind, requestId])), reservation: total };
  });
}

export async function replaceBuildAsset(sid: string, pid: string, id: unknown, input: Record<string, unknown>, kind: AssetKind) {
  const db = await access(sid, pid, id); consent(input);
  if (!isSafeId(input.plan_id)) throw new CreatorError("Invalid asset plan item", 400);
  const key = stageKey(`${sid}:${pid}:${id}`, kind), existing = await db.collection<BuildAssetDoc>("place_build_assets").findOne({ _id: key });
  const replay = (stage: BuildAssetDoc) => {
    const op = stage.replacements.find(r => r.id === input.request_id);
    if (!op) return null;
    if (op.plan_id !== input.plan_id) throw new CreatorError("Replacement identity already used", 409);
    sameQuote(op.quote, input); return { job_id: op.job_id };
  };
  if (existing) { const result = replay(existing); if (result) return result; }
  const quote = await checkedAssetQuote(db, kind, input);
  return withDbTransaction(async (db, session) => {
    const stages = db.collection<BuildAssetDoc>("place_build_assets"), options = { session };
    const stage = await stages.findOne({ _id: key }, options);
    if (!stage) throw new CreatorError("Asset stage not found", 404);
    const repeated = replay(stage); if (repeated) return repeated;
    const build = await currentBuild(db, sid, pid, id as string, session, kind), acceptedPlan = plans(build, kind)!;
    if (stage.cancelled || stage.replacements.length >= 30 || buildInputHash(build.result) !== stage.result_sha256 || buildInputHash(acceptedPlan) !== stage.plan_sha256) throw new CreatorError("This asset stage cannot be replaced", 409);
    const plan = acceptedPlan.find(p => p.id === input.plan_id), item = stage.items.find(i => i.plan_id === input.plan_id);
    const old = item && await db.collection<MeshJobDoc>(`${kind}_jobs`).findOne({ _id: `${sid}:${item.job_id}` }, options);
    // Unknown work must be explicitly cancelled first. A read timeout is never
    // permission to start a replacement that might duplicate a live submission.
    if (!plan || !item || !old || !["failed", "cancelled"].includes(old.status)) throw new CreatorError("Only failed or explicitly discarded assets can be replaced", 409);
    const job = await reserveAssetJob(db, session, sid, kind, randomUUID(), plan.prompt, quote,
      { kind, place_id: pid, revision: build.base_revision, input_sha256: build.input_sha256, build_key: build._id, result_sha256: stage.result_sha256, plan_sha256: stage.plan_sha256, ...(build.connections_sha256 ? { connections_sha256: build.connections_sha256 } : {}) });
    await stages.updateOne({ _id: key }, { $set: { items: stage.items.map(i => i.plan_id === plan.id ? { ...i, job_id: job.id } : i),
      replacements: [...stage.replacements, { id: input.request_id as string, plan_id: plan.id, job_id: job.id, quote }], reservation: stage.reservation + quote.reservation } }, options);
    return { job_id: job.id };
  });
}

export async function refreshBuildAsset(sid: string, pid: string, id: unknown, jobId: unknown, kind: AssetKind) {
  const db = await access(sid, pid, id);
  const stage = await db.collection<BuildAssetDoc>("place_build_assets").findOne({ _id: stageKey(`${sid}:${pid}:${id}`, kind) });
  if (!stage || stage.cancelled || !stage.items.some(i => i.job_id === jobId)) throw new CreatorError("Asset dependency not found", 404);
  return refreshMesh(sid, jobId, kind);
}

export async function cancelBuildAssets(sid: string, pid: string, id: unknown, kind: AssetKind, jobId?: unknown) {
  await access(sid, pid, id);
  return withDbTransaction(async (db, session) => {
    const stages = db.collection<BuildAssetDoc>("place_build_assets"), options = { session };
    const stage = await stages.findOne({ _id: stageKey(`${sid}:${pid}:${id}`, kind) }, options);
    if (!stage || jobId !== undefined && !stage.items.some(i => i.job_id === jobId)) throw new CreatorError("Asset dependency not found", 404);
    for (const item of stage.items.filter(i => jobId === undefined || i.job_id === jobId)) {
      const job = await db.collection<MeshJobDoc>(`${kind}_jobs`).findOne({ _id: `${sid}:${item.job_id}` }, options);
      if (job && !["ready", "failed", "cancelled"].includes(job.status)) await cancelReservedAsset(db, session, sid, kind, item.job_id);
    }
    if (jobId === undefined) await stages.updateOne({ _id: stage._id }, { $set: { cancelled: true } }, options);
    return { stage_id: stage.id };
  });
}

export async function assetBuildDefinition(db: Db, build: BuildDoc, kind: AssetKind, definition: PlaceSceneDefinition = build.result!) {
  const stage = await readBuildAssetStage(db, build, kind);
  if (!stage) {
    if (build.appearance_approval && plans(build, kind)?.length) throw new CreatorError("A saved appearance stage is missing. Restore its records or explicitly preview layout only.", 409);
    return definition;
  }
  if (stage.status !== "ready") throw new CreatorError(`${kind} assets are not ready. Resolve their jobs or explicitly preview layout only.`, 409);
  if (kind === "mesh") {
    const meshes = new Map<string, { id: string; size: Awaited<ReturnType<typeof savedMeshDimensions>> }>();
    for (const item of stage.items) {
      if (!item.job.asset_id) throw new CreatorError("A mesh dependency is missing", 409);
      meshes.set(item.plan_id, { id: item.job.asset_id, size: await savedMeshDimensions(db, build.session_id, item.job.asset_id) });
    }
    try { return bindPlannedMeshes(definition, build.mesh_plan!, meshes); }
    catch (error) { throw new CreatorError((error as Error).message, 422); }
  }
  const assets = new Map<string, string>();
  for (const item of stage.items) {
    const asset = await db.collection<MeshAssetDoc>("material_assets").findOne({ _id: `${build.session_id}:${item.job.asset_id}`, session_id: build.session_id });
    if (!asset?.image || asset.image.channel !== "base_color") throw new CreatorError("A saved material dependency is missing", 409);
    assets.set(item.plan_id, asset.id);
  }
  return bindPlannedMaterials(definition, build.material_plan!, assets);
}

// Existing material routes and saved stage keys remain compatible.
export const readBuildMaterialStage = (db: Db, build: BuildDoc) => readBuildAssetStage(db, build, "material");
export const queueBuildMaterials = (sid: string, pid: string, id: unknown, input: Record<string, unknown>) => queueBuildAssets(sid, pid, id, input, "material");
export const replaceBuildMaterial = (sid: string, pid: string, id: unknown, input: Record<string, unknown>) => replaceBuildAsset(sid, pid, id, input, "material");
export const refreshBuildMaterial = (sid: string, pid: string, id: unknown, job: unknown) => refreshBuildAsset(sid, pid, id, job, "material");
export const cancelBuildMaterials = (sid: string, pid: string, id: unknown, job?: unknown) => cancelBuildAssets(sid, pid, id, "material", job);
export const materialBuildDefinition = (db: Db, build: BuildDoc) => assetBuildDefinition(db, build, "material");
