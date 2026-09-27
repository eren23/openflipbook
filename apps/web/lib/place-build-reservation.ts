import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator";
import { buildInputHash, placeBuildBackend, placeBuildWorkerAvailable, type BuildDoc } from "./place-build-execution";
import { connectionInputHash, readBuildConnections } from "./place-build-connections";
import type { SceneDoc } from "./place-scene-store";
import type { PlaceBuildJob } from "./place-build";
import { placementFloor } from "./floor-placement";

export const wireBuild = (j: BuildDoc): PlaceBuildJob => ({ id: j.id, prompt: j.prompt, model: j.model, reservation: j.reservation, base_revision: j.base_revision,
  ...(j.target_floor ? { target_floor: j.target_floor } : {}),
  status: j.status, created_at: j.created_at, ...(j.error ? { error: j.error } : {}), ...(j.result ? { object_count: j.result.objects.length - j.input.objects.length } : {}),
  ...(j.material_plan?.length ? { material_plan: j.material_plan } : {}), ...(j.mesh_plan?.length ? { mesh_plan: j.mesh_plan } : {}),
  ...(j.appearance_approval ? { appearance_approval: { id: j.appearance_approval.id, kinds: j.appearance_approval.kinds, total_reservation: j.appearance_approval.total_reservation } } : {}) });
interface BuildRequest {
  id: string; prompt: string; base_revision: number; model: unknown; reservation: unknown;
  expansion?: BuildDoc["expansion"];
  target_floor?: BuildDoc["target_floor"];
}
export function parseBuildRequest(input: Record<string, unknown>): BuildRequest {
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id) || typeof input.prompt !== "string" || input.prompt.trim().length < 3 || input.prompt.length > 4000 || input.confirmed !== true || !Number.isSafeInteger(input.base_revision)) throw new CreatorError("Description, saved revision and explicit generation consent are required", 400);
  const target = input.target_floor as BuildDoc["target_floor"];
  if (input.target_floor !== undefined && (!target || typeof target !== "object" || Array.isArray(target)
    || Object.keys(target).some(k => !["building_id", "floor_id"].includes(k))
    || ![target.building_id, target.floor_id].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id)))) throw new CreatorError("Invalid generation floor target", 400);
  return { id: input.id, prompt: input.prompt.trim(), base_revision: input.base_revision as number, model: input.model, reservation: input.reservation,
    ...(target ? { target_floor: { building_id: target.building_id, floor_id: target.floor_id } } : {}) };
}
export function matchBuildRequest(job: BuildDoc, input: BuildRequest) {
  if (job.prompt !== input.prompt || job.base_revision !== input.base_revision || job.reservation !== input.reservation || job.model !== input.model || job.expansion?.source_place_id !== input.expansion?.source_place_id || job.expansion?.proposal_id !== input.expansion?.proposal_id
    || job.target_floor?.building_id !== input.target_floor?.building_id || job.target_floor?.floor_id !== input.target_floor?.floor_id) throw new CreatorError("Generation request id already used", 409);
  return job;
}
export async function prepareBuildReservation(db: Db, input: BuildRequest) {
  let config;
  try { config = await placeBuildBackend("capabilities"); }
  catch { throw new CreatorError("Layout generation backend unavailable", 503); }
  if (!config.enabled || typeof config.model !== "string" || !config.model || config.model.length > 200 || !Number.isFinite(config.reservation) || config.reservation <= 0 || config.reservation > 10) throw new CreatorError("Layout generation is not enabled", 503);
  if (!await placeBuildWorkerAvailable(db)) throw new CreatorError("Layout worker offline. No reservation created.", 503);
  if (input.target_floor && (config.floor_target_version !== 1 || !await placeBuildWorkerAvailable(db, false, true))) throw new CreatorError("Floor generation requires updated backend and layout workers. No reservation created.", 503);
  if (input.reservation !== config.reservation || input.model !== config.model) throw new CreatorError("Generation configuration changed. Review the new reservation.", 409);
  const cap = (key: string, fallback: string, allowZero: boolean) => { const value = Number(process.env[key] ?? fallback); if (!Number.isFinite(value) || value < 0 || !allowZero && value === 0) throw new CreatorError("Invalid generation spend cap", 503); return value; };
  return { model: config.model as string, reservation: config.reservation as number, connected: config.connection_context_version === 1,
    caps: [cap("MAX_DAILY_SPEND", "0", true), cap("MAX_SESSION_SPEND", "0", true), cap("PLACE_BUILD_DAILY_CAP_USD", "1", false)] };
}

// Both ordinary builds and adjoining creation reserve through this caller-owned
// transaction. No provider submission occurs until the committed worker claim.
export async function reservePlaceBuild(db: Db, session: ClientSession, sid: string, pid: string, input: BuildRequest, config: Awaited<ReturnType<typeof prepareBuildReservation>>, scheduled = false) {
  const jobs = db.collection<BuildDoc>("place_build_jobs"), options = { session }, key = `${sid}:${pid}:${input.id}`;
  const previous = await jobs.findOne({ _id: key }, options); if (previous) return matchBuildRequest(previous, input);
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}` }, options);
  if (!scene || scene.revision !== input.base_revision) throw new CreatorError("Save or reload the place before generating", 409);
  if (input.target_floor) {
    if (input.expansion) throw new CreatorError("An adjoining build cannot target an existing floor", 400);
    try { placementFloor(scene.definition, input.target_floor); } catch { throw new CreatorError("The generation floor is not in this saved place", 409); }
  }
  if (scene.definition.objects.length >= 100 || (scene.generation_sources?.length ?? 0) >= 100) throw new CreatorError("This place has reached its generation capacity", 409);
  const connection_input = await readBuildConnections(db, sid, pid, session);
  if (connection_input.connections.length && (!config.connected || !await placeBuildWorkerAvailable(db, true))) throw new CreatorError("Connected layout generation requires an updated backend and all layout workers. No reservation created.", 503);
  const now = new Date(), day = now.toISOString().slice(0, 10), ledgerIds = [`day:${day}`, `sess:${sid}:${day}`, `place-build:${day}`];
  const ledger = db.collection<{ _id: string; total: number }>("spend_ledger");
  for (const [i, ledgerId] of ledgerIds.entries()) {
    const old = await ledger.findOne({ _id: ledgerId }, options);
    if (config.caps[i]! > 0 && (old?.total ?? 0) + config.reservation > config.caps[i]!) throw new CreatorError("Generation spend cap reached", 429);
    await ledger.updateOne({ _id: ledgerId }, { $inc: { total: config.reservation } }, { ...options, upsert: true });
  }
  const job: BuildDoc = { _id: key, id: input.id, session_id: sid, place_id: pid, prompt: input.prompt, model: config.model, reservation: config.reservation,
    status: scheduled ? "scheduled" : "queued", base_revision: scene.revision, created_at: now.toISOString(), input: scene.definition, input_sha256: buildInputHash(scene.definition),
    connection_input, connections_sha256: connectionInputHash(connection_input), ledger_ids: ledgerIds, ...(input.expansion ? { expansion: input.expansion } : {}), ...(input.target_floor ? { target_floor: input.target_floor } : {}) };
  await jobs.insertOne(job, options); return job;
}
