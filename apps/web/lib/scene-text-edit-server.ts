import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "mongodb";
import type { PlaceBuildConnectionInput, PlaceSceneDefinition, SceneTextEditReceipt } from "@openflipbook/config";
import { withDbTransaction } from "./db";
import { requireCreator, CreatorError } from "./creator";
import { isSafeId } from "./ids";
import { modalAuthHeaders, modalUrl } from "./modal";
import { placeScenesEnabled } from "./place-scene-enabled";
import { previewPlaceScene, applyPlaceScene, sceneKey, type ProposalDoc } from "./place-scene-server";
import type { SceneDoc } from "./place-scene-store";
import { buildConnectionsCurrent, connectionInputHash, readBuildConnections, requireBuildConnections } from "./place-build-connections";
import { applySceneTextEdits } from "./scene-text-edit";
import type { MeshAssetDoc } from "./mesh-docs";
import { materialAssetIds } from "./surface-material";

export type SceneEditStatus = "scheduled" | "planning" | "submission_unknown" | "validating" | "ready" | "invalid" | "cancelled";
export interface SceneEditJob {
  id: string; prompt: string; model: string; reservation: number; base_revision: number;
  selected_object_ids: string[]; status: SceneEditStatus; created_at: string; error?: string; proposal_id?: string;
}
interface EditResponse { status: "ready" | "invalid"; model: string; request_id?: string; raw_text: string; result?: unknown; usage?: unknown }
type MaterialInput = { id: string; sha256: string; prompt: string };
export interface SceneEditDoc extends Omit<SceneEditJob, "proposal_id"> {
  _id: string; session_id: string; place_id: string; request_sha256: string;
  input: PlaceSceneDefinition; scene_sha256: string; input_sha256: string;
  connection_input: PlaceBuildConnectionInput; connections_sha256: string; materials: MaterialInput[];
  ledger_ids: string[]; proposal_id: string; execution_token?: string; deadline?: Date; submission_started_at?: Date;
  provider_response?: EditResponse; received_at?: string; result?: PlaceSceneDefinition; receipt?: SceneTextEditReceipt;
}
export const sceneEditHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const wireSceneEdit = (j: SceneEditDoc): SceneEditJob => ({ id: j.id, prompt: j.prompt, model: j.model, reservation: j.reservation, base_revision: j.base_revision,
  selected_object_ids: j.selected_object_ids, status: j.status, created_at: j.created_at, ...(j.error ? { error: j.error } : {}), ...(j.status === "ready" ? { proposal_id: j.proposal_id } : {}) });
const interrupted = "Planning was interrupted. It may be billable; no automatic retry will be submitted.";
const inputHash = (j: Pick<SceneEditDoc, "input" | "selected_object_ids" | "connection_input" | "materials">) => sceneEditHash([j.input, j.selected_object_ids, j.connection_input, j.materials]);
async function access(sid: string, pid: string) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(sid) || !isSafeId(pid)) throw new CreatorError("Invalid place", 400);
  return requireCreator(sid);
}
export async function sceneEditBackend(path: string, body?: unknown) {
  if (!process.env.MODAL_API_URL) throw new Error("Scene edit backend is not configured");
  const response = await fetch(modalUrl(process.env.MODAL_API_URL, `/scene-edit/${path}`), { method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...modalAuthHeaders() }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(body ? 170_000 : 10_000) });
  if (!response.ok) throw new Error(`Scene edit backend returned ${response.status}`);
  const text = await response.text(); if (text.length > 750_000) throw new Error("Scene edit response is too large");
  return JSON.parse(text);
}
async function workerAvailable(db: Db) {
  return !!await db.collection("generation_workers").findOne({ kind: "place-layout", scene_edits: true, last_seen: { $gt: new Date(Date.now() - 30_000) } });
}
export async function expireSceneEdits(db: Db, scope: { session_id?: string; place_id?: string } = {}) {
  await db.collection<SceneEditDoc>("scene_edit_jobs").updateMany({ ...scope, status: "planning", deadline: { $lt: new Date() } }, { $set: { status: "submission_unknown", error: interrupted } });
}
export async function sceneEditLibrary(sid: string, pid: string) {
  const db = await access(sid, pid); await expireSceneEdits(db, { session_id: sid, place_id: pid });
  const jobs = await db.collection<SceneEditDoc>("scene_edit_jobs").find({ session_id: sid, place_id: pid }).sort({ created_at: -1 }).limit(30).toArray();
  let capabilities;
  try {
    capabilities = await sceneEditBackend("capabilities");
    if (capabilities.contract_version !== 1 || !await workerAvailable(db)) capabilities = { ...capabilities, enabled: false, reason: "Updated scene edit worker unavailable. Saved requests are retained." };
  } catch { capabilities = { enabled: false, reason: "Scene edit backend unavailable" }; }
  return { jobs: jobs.map(wireSceneEdit), capabilities };
}
function parseRequest(input: Record<string, unknown>) {
  const selected = input.selected_object_ids ?? [];
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id) || typeof input.prompt !== "string" || input.prompt.trim().length < 3 || input.prompt.length > 4000
    || input.confirmed !== true || !Number.isSafeInteger(input.base_revision) || Number(input.base_revision) < 1
    || typeof input.model !== "string" || !input.model || input.model.length > 200 || typeof input.reservation !== "number" || !Number.isFinite(input.reservation) || input.reservation <= 0 || input.reservation > 10
    || !Array.isArray(selected) || selected.length > 20 || !selected.every(isSafeId) || new Set(selected).size !== selected.length)
    throw new CreatorError("Description, saved revision, quote and explicit scene edit consent are required", 400);
  return { id: input.id, prompt: input.prompt.trim(), base_revision: Number(input.base_revision), model: input.model, reservation: input.reservation, selected_object_ids: [...selected].sort() as string[] };
}
const matchRequest = (job: SceneEditDoc, request: ReturnType<typeof parseRequest>) => {
  if (job.request_sha256 !== sceneEditHash(request)) throw new CreatorError("Scene edit request id already used", 409); return job;
};
export async function queueSceneEdit(sid: string, pid: string, input: Record<string, unknown>) {
  const db = await access(sid, pid), request = parseRequest(input), key = `${sid}:${pid}:${request.id}`;
  const old = await db.collection<SceneEditDoc>("scene_edit_jobs").findOne({ _id: key });
  if (old) return { job: wireSceneEdit(matchRequest(old, request)) };
  let config;
  try { config = await sceneEditBackend("capabilities"); } catch { throw new CreatorError("Scene edit backend unavailable", 503); }
  if (!config.enabled || config.contract_version !== 1 || !await workerAvailable(db)) throw new CreatorError("Scene edits require an updated backend and worker. No reservation created.", 503);
  if (config.model !== request.model || config.reservation !== request.reservation) throw new CreatorError("Scene edit quote changed. Review the new reservation.", 409);
  const caps = [["MAX_DAILY_SPEND", "0"], ["MAX_SESSION_SPEND", "0"], ["SCENE_EDIT_DAILY_CAP_USD", "1"]].map(([name, fallback]) => Number(process.env[name!] ?? fallback));
  if (caps.some(v => !Number.isFinite(v) || v < 0) || caps[2] === 0) throw new CreatorError("Invalid scene edit spend cap", 503);
  return withDbTransaction(async (database, session) => {
    const options = { session }, jobs = database.collection<SceneEditDoc>("scene_edit_jobs");
    const previous = await jobs.findOne({ _id: key }, options); if (previous) return { job: wireSceneEdit(matchRequest(previous, request)) };
    const scene = await database.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) }, options);
    if (!scene || scene.revision !== request.base_revision || request.selected_object_ids.some(id => !scene.definition.objects.some(o => o.id === id))) throw new CreatorError("Save or reload this selection before planning an edit", 409);
    if ((scene.edit_sources?.length ?? 0) >= 100) throw new CreatorError("This place has reached its text edit capacity", 409);
    const connection_input = await readBuildConnections(database, sid, pid, session);
    const savedMaterials = await database.collection<MeshAssetDoc>("material_assets").find({ session_id: sid }, options).sort({ created_at: -1 }).limit(100).toArray();
    const materials: MaterialInput[] = [], used = materialAssetIds(scene.definition);
    if (used.length > 100) throw new CreatorError("This scene has too many material references for one edit request", 409);
    for (const id of used) {
      const m = savedMaterials.find(asset => asset.id === id) ?? await database.collection<MeshAssetDoc>("material_assets").findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
      if (!m) throw new CreatorError("A saved scene material is unavailable", 409);
      materials.push({ id: m.id, sha256: m.sha256, prompt: m.prompt.slice(0, 300) });
    }
    for (const m of savedMaterials) if (materials.length < 100 && !materials.some(old => old.id === m.id)) materials.push({ id: m.id, sha256: m.sha256, prompt: m.prompt.slice(0, 300) });
    const now = new Date(), day = now.toISOString().slice(0, 10), ledger_ids = [`day:${day}`, `sess:${sid}:${day}`, `scene-edit:${day}`];
    const ledger = database.collection<{ _id: string; total: number }>("spend_ledger");
    for (const [i, id] of ledger_ids.entries()) {
      const oldLedger = await ledger.findOne({ _id: id }, options);
      if (caps[i]! > 0 && (oldLedger?.total ?? 0) + request.reservation > caps[i]!) throw new CreatorError("Scene edit spend cap reached", 429);
      await ledger.updateOne({ _id: id }, { $inc: { total: request.reservation } }, { ...options, upsert: true });
    }
    const frozen = { input: scene.definition, selected_object_ids: request.selected_object_ids, connection_input, materials };
    if (Buffer.byteLength(JSON.stringify({ prompt: request.prompt, definition: frozen.input, selected_object_ids: frozen.selected_object_ids, connection_input, materials }), "utf8") > 240_000)
      throw new CreatorError("Saved scene context is too large for one text edit request", 413);
    const job: SceneEditDoc = { ...request, ...frozen, _id: key, session_id: sid, place_id: pid, request_sha256: sceneEditHash(request), scene_sha256: sceneEditHash(scene.definition),
      input_sha256: inputHash(frozen), connections_sha256: connectionInputHash(connection_input), status: "scheduled", created_at: now.toISOString(), ledger_ids, proposal_id: randomUUID() };
    // Serialize reservation and geometry changes without changing authored revision.
    await database.collection<SceneDoc>("place_scenes").updateOne({ _id: scene._id, revision: scene.revision }, { $inc: { text_edit_fence: 1 } }, options);
    await jobs.insertOne(job, options); return { job: wireSceneEdit(job) };
  });
}
export async function finalizeSceneEdit(db: Db, job: SceneEditDoc) {
  if (job.status !== "validating") return;
  const response = job.provider_response;
  if (!response || !job.execution_token) {
    await db.collection<SceneEditDoc>("scene_edit_jobs").updateOne({ _id: job._id, status: "validating" }, { $set: { status: "submission_unknown", error: "Saved response is incomplete. Reservation retained; no automatic retry." } }); return;
  }
  let result: PlaceSceneDefinition | undefined, receipt: SceneTextEditReceipt | undefined, error: string | undefined;
  try {
    if (response.status !== "ready" || response.model !== job.model || inputHash(job) !== job.input_sha256 || sceneEditHash(job.input) !== job.scene_sha256) throw new Error("Saved response or request is incomplete or invalid");
    const raw = JSON.parse(response.raw_text);
    if (!isDeepStrictEqual(raw, response.result)) throw new Error("Saved raw response differs from its parsed edit result");
    const accepted = applySceneTextEdits(job.input, raw, job.id, job.selected_object_ids, job.connection_input);
    if (materialAssetIds(accepted.definition).some(id => !job.materials.some(m => m.id === id))) throw new Error("The edit requests a material outside its saved library");
    const meshes = new Set(job.input.objects.flatMap(o => o.asset_id ? [o.asset_id] : []));
    if (accepted.definition.objects.some(o => o.asset_id && !meshes.has(o.asset_id))) throw new Error("New mesh generation needs a separate quote");
    result = accepted.definition;
    receipt = { version: 1, job_id: job.id, model: job.model, request_id: typeof response.request_id === "string" ? response.request_id.slice(0, 200) : null, prompt: job.prompt,
      base_revision: job.base_revision, input_sha256: job.input_sha256, output_sha256: sceneEditHash(result), object_ids: accepted.object_ids, selected_object_ids: job.selected_object_ids,
      reserved_usd: job.reservation, created_at: job.received_at ?? job.created_at, connection_input: job.connection_input, connections_sha256: job.connections_sha256 };
  } catch (e) { error = `Scene edit rejected: ${(e as Error).message}`.slice(0, 500); }
  await db.collection<SceneEditDoc>("scene_edit_jobs").updateOne({ _id: job._id, status: "validating", execution_token: job.execution_token }, {
    $set: result && receipt ? { status: "ready", result, receipt } : { status: "invalid", error: error ?? "Scene edit rejected" }, ...(result && receipt ? { $unset: { error: "" } } : {}) });
}
export async function processNextSceneEdit(db: Db) {
  await expireSceneEdits(db);
  const saved = await db.collection<SceneEditDoc>("scene_edit_jobs").findOne({ status: "validating" }, { sort: { created_at: 1 } });
  if (saved) { await finalizeSceneEdit(db, saved); return true; }
  const job = await withDbTransaction(async (database, session) => {
    const options = { session }, jobs = database.collection<SceneEditDoc>("scene_edit_jobs");
    const queued = await jobs.findOne({ status: "scheduled" }, { ...options, sort: { created_at: 1, _id: 1 } }); if (!queued) return null;
    const scene = await database.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(queued.session_id, queued.place_id) }, options);
    let materialsCurrent = true;
    for (const m of queued.materials) if (!await database.collection<MeshAssetDoc>("material_assets").findOne({ _id: `${queued.session_id}:${m.id}`, session_id: queued.session_id, sha256: m.sha256 }, options)) materialsCurrent = false;
    if (!scene || scene.revision !== queued.base_revision || sceneEditHash(scene.definition) !== queued.scene_sha256 || inputHash(queued) !== queued.input_sha256
      || !materialsCurrent || !await buildConnectionsCurrent(database, queued, session)) {
      for (const id of queued.ledger_ids) await database.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -queued.reservation } }, options);
      await jobs.updateOne({ _id: queued._id, status: "scheduled" }, { $set: { status: "cancelled", error: "Saved edit inputs changed before submission; reservation released." } }, options); return null;
    }
    const claimed = { ...queued, status: "planning" as const, execution_token: randomUUID(), deadline: new Date(Date.now() + 180_000) };
    await database.collection<SceneDoc>("place_scenes").updateOne({ _id: scene._id, revision: scene.revision }, { $inc: { text_edit_fence: 1 } }, options);
    await jobs.updateOne({ _id: queued._id, status: "scheduled" }, { $set: { status: claimed.status, execution_token: claimed.execution_token, deadline: claimed.deadline } }, options); return claimed;
  });
  if (!job) return false;
  const jobs = db.collection<SceneEditDoc>("scene_edit_jobs");
  const authorized = await jobs.findOneAndUpdate({ _id: job._id, execution_token: job.execution_token, status: "planning", deadline: { $gt: new Date() }, submission_started_at: { $exists: false } },
    { $set: { submission_started_at: new Date() } }, { returnDocument: "after" });
  if (!authorized) return true;
  try {
    const response = await sceneEditBackend("plan", { prompt: job.prompt, model: job.model, reservation: job.reservation, definition: job.input, selected_object_ids: job.selected_object_ids, connection_input: job.connection_input, materials: job.materials });
    if (!response || response.model !== job.model || !["ready", "invalid"].includes(response.status) || typeof response.raw_text !== "string" || response.raw_text.length > 250_000) throw new Error("Unrecognized scene edit response");
    await jobs.updateOne({ _id: job._id, execution_token: job.execution_token, status: { $in: ["planning", "submission_unknown"] } },
      { $set: { status: "validating", provider_response: response, received_at: new Date().toISOString() }, $unset: { error: "" } });
    const received = await jobs.findOne({ _id: job._id }); if (received) await finalizeSceneEdit(db, received);
  } catch { await jobs.updateOne({ _id: job._id, execution_token: job.execution_token, status: "planning" }, { $set: { status: "submission_unknown", error: interrupted } }); }
  return true;
}
export async function sceneEditAction(sid: string, pid: string, input: Record<string, unknown>) {
  if (input.action === "plan") return queueSceneEdit(sid, pid, input);
  const db = await access(sid, pid); if (!isSafeId(input.id)) throw new CreatorError("Invalid scene edit job", 400);
  const key = `${sid}:${pid}:${input.id}`;
  if (input.action === "cancel") return withDbTransaction(async (database, session) => {
    const options = { session }, jobs = database.collection<SceneEditDoc>("scene_edit_jobs"), job = await jobs.findOne({ _id: key }, options);
    if (!job) throw new CreatorError("Scene edit job not found", 404);
    if (job.status === "cancelled") return { job: wireSceneEdit(job) };
    if (!["scheduled", "planning", "submission_unknown", "validating"].includes(job.status)) throw new CreatorError("This scene edit can no longer be cancelled", 409);
    if (job.status === "scheduled") for (const id of job.ledger_ids) await database.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -job.reservation } }, options);
    const error = job.status === "scheduled" ? "Cancelled before submission; reservation released." : "Result discarded. The provider may still finish and be billable; reservation retained.";
    await jobs.updateOne({ _id: key }, { $set: { status: "cancelled", error } }, options); return { job: wireSceneEdit({ ...job, status: "cancelled", error }) };
  });
  const job = await db.collection<SceneEditDoc>("scene_edit_jobs").findOne({ _id: key });
  if (!job || job.status !== "ready" || !job.result || !job.receipt || sceneEditHash(job.result) !== job.receipt.output_sha256) throw new CreatorError("No complete saved edit result is available", 409);
  const refreshing = input.action === "refresh-preview";
  if (refreshing && (typeof input.review_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.review_id))) throw new CreatorError("A durable refresh review ID is required", 400);
  const proposalId = refreshing ? `textreview_${sceneEditHash([sid, pid, job.id, input.review_id]).slice(0, 40)}` : input.action === "apply" && input.proposal_id !== undefined ? input.proposal_id : job.proposal_id;
  if (!isSafeId(proposalId)) throw new CreatorError("Invalid saved review proposal", 400);
  const savedProposal = await db.collection<ProposalDoc>("world_edit_proposals").findOne({ _id: proposalId, session_id: sid, place_id: pid });
  if (input.action === "preview" || refreshing) {
    if (!savedProposal) {
      const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) });
      if (!scene || scene.revision !== job.base_revision || sceneEditHash(scene.definition) !== job.scene_sha256) throw new CreatorError("Saved geometry changed; this edit cannot be rebased", 409);
      await requireBuildConnections(db, job);
      for (const m of job.materials) if (!await db.collection<MeshAssetDoc>("material_assets").findOne({ _id: `${sid}:${m.id}`, session_id: sid, sha256: m.sha256 })) throw new CreatorError("Saved edit materials changed before preview", 409);
    }
    return previewPlaceScene(sid, pid, { base_revision: job.base_revision, definition: job.result }, undefined, undefined, { id: proposalId, receipt: job.receipt });
  }
  if (input.action === "apply") {
    const proposal = savedProposal;
    if (!proposal || !isDeepStrictEqual(proposal.edit_source, job.receipt) || !isDeepStrictEqual(proposal.definition, job.result)) throw new CreatorError("Preview this saved edit proposal before applying", 409);
    return applyPlaceScene(sid, pid, proposal.id);
  }
  throw new CreatorError("Unknown scene edit action", 400);
}
