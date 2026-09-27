import { requireCreator, CreatorError } from "./creator";
import { withDbTransaction } from "./db";
import type { PlaceBuildJob } from "./place-build";
import { buildInputHash as hash, expirePlaceBuilds, placeBuildBackend, placeBuildWorkerAvailable, type BuildDoc } from "./place-build-execution";
import { previewPlaceScene, sceneKey } from "./place-scene-server";
import type { SceneDoc } from "./place-scene-store";
import { randomUUID } from "node:crypto";
import { placeScenesEnabled } from "./place-scene-enabled";
import { isSafeId } from "./ids";
import { assetBuildDefinition, readBuildMaterialStage, readBuildAssetStage } from "./place-build-assets-server";
import { meshLibrary } from "./mesh-server";
import { buildConnectionsMatch, readBuildConnections, requireBuildConnections } from "./place-build-connections";
import { matchBuildRequest, parseBuildRequest, prepareBuildReservation, reservePlaceBuild, wireBuild as wire } from "./place-build-reservation";

export type { BuildDoc } from "./place-build-execution";
async function access(sid: string, pid: string) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(pid)) throw new CreatorError("Invalid place", 400);
  return requireCreator(sid);
}
export async function placeBuildLibrary(sid: string, pid: string) {
  const db = await access(sid, pid), col = db.collection<BuildDoc>("place_build_jobs");
  await expirePlaceBuilds(db, { session_id: sid, place_id: pid });
  const jobs = await col.find({ session_id: sid, place_id: pid }).sort({ created_at: -1 }).limit(30).toArray();
  const connectionInput = await readBuildConnections(db, sid, pid);
  let capabilities;
  try {
    capabilities = await placeBuildBackend("capabilities");
    if (capabilities.enabled && !await placeBuildWorkerAvailable(db)) capabilities = { ...capabilities, enabled: false, reason: "Layout worker offline. Reserved jobs are retained." };
    if (capabilities.enabled && connectionInput.connections.length && (capabilities.connection_context_version !== 1 || !await placeBuildWorkerAvailable(db, true))) capabilities = { ...capabilities, enabled: false, reason: "Connected layouts require updated backend and layout workers. Saved jobs are retained." };
  }
  catch { capabilities = { enabled: false, reason: "Layout generation backend unavailable" }; }
  if (capabilities.floor_target_version === 1 && !await placeBuildWorkerAvailable(db, false, true)) capabilities = { ...capabilities, floor_target_version: 0 };
  const result: PlaceBuildJob[] = [];
  for (const job of jobs) {
    const material_stage = await readBuildMaterialStage(db, job);
    const mesh_stage = await readBuildAssetStage(db, job, "mesh");
    result.push({ ...wire(job), stale_connections: !buildConnectionsMatch(job, connectionInput), ...(material_stage ? { material_stage } : {}), ...(mesh_stage ? { mesh_stage } : {}) });
  }
  const material_capabilities = jobs.some(j => j.material_plan?.length) ? (await meshLibrary(sid, "material")).capabilities : undefined;
  const mesh_capabilities = jobs.some(j => j.mesh_plan?.length) ? (await meshLibrary(sid, "mesh")).capabilities : undefined;
  return { jobs: result, capabilities, ...(material_capabilities ? { material_capabilities } : {}), ...(mesh_capabilities ? { mesh_capabilities } : {}) };
}
export async function queuePlaceBuild(sid: string, pid: string, input: Record<string, unknown>) {
  const db = await access(sid, pid);
  const request = parseBuildRequest(input);
  const old = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: `${sid}:${pid}:${request.id}` });
  if (old) return { job: wire(matchBuildRequest(old, request)) };
  const config = await prepareBuildReservation(db, request);
  return withDbTransaction(async (db, session) => ({ job: wire(await reservePlaceBuild(db, session, sid, pid, request, config)) }));
}
export async function runPlaceBuild(sid: string, pid: string, id: unknown) {
  await access(sid, pid);
  if (!isSafeId(id)) throw new CreatorError("Invalid generation job", 400);
  const key = `${sid}:${pid}:${id}`;
  return withDbTransaction(async (db, session) => {
    const jobs = db.collection<BuildDoc>("place_build_jobs"), options = { session };
    const job = await jobs.findOne({ _id: key }, options);
    if (!job) throw new CreatorError("Generation job not found", 404);
    if (job.status !== "queued") return { job: wire(job) };
    const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) }, options);
    if (!scene || scene.revision !== job.base_revision || hash(scene.definition) !== job.input_sha256) throw new CreatorError("Place changed before generation. Cancel this queued job.", 409);
    await requireBuildConnections(db, job, session);
    await jobs.updateOne({ _id: key, status: "queued" }, { $set: { status: "scheduled" } }, options);
    return { job: wire({ ...job, status: "scheduled" }) };
  });
}
export async function cancelPlaceBuild(sid: string, pid: string, id: unknown) {
  await access(sid, pid); if (!isSafeId(id)) throw new CreatorError("Invalid generation job", 400);
  return withDbTransaction(async (db, session) => {
    const col = db.collection<BuildDoc>("place_build_jobs"), options = { session }, key = `${sid}:${pid}:${id}`;
    const job = await col.findOne({ _id: key }, options); if (!job) throw new CreatorError("Generation job not found", 404);
    if (job.status === "cancelled") return { job: wire(job) };
    if (!["queued", "scheduled", "planning", "validating", "submission_unknown"].includes(job.status)) throw new CreatorError("This job can no longer be cancelled", 409);
    const unsubmitted = ["queued", "scheduled"].includes(job.status);
    if (unsubmitted) for (const ledgerId of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: ledgerId }, { $inc: { total: -job.reservation } }, options);
    const error = unsubmitted ? "Cancelled before submission; reservation released." : "Result discarded. The provider call may still finish and be billable; reservation retained.";
    await col.updateOne({ _id: key }, { $set: { status: "cancelled", error } }, options);
    return { job: wire({ ...job, status: "cancelled", error }) };
  });
}
export async function revalidatePlaceBuild(sid: string, pid: string, id: unknown) {
  await access(sid, pid);
  if (!isSafeId(id)) throw new CreatorError("Invalid generation job", 400);
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<BuildDoc>("place_build_jobs"), key = `${sid}:${pid}:${id}`;
    const job = await jobs.findOne({ _id: key }, options);
    if (!job) throw new CreatorError("Generation job not found", 404);
    if (["validating", "ready"].includes(job.status)) return { job: wire(job) };
    if (job.status !== "invalid" || job.provider_response?.status !== "ready" || !job.provider_response.result)
      throw new CreatorError("No complete saved layout response is available to revalidate", 409);
    const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) }, options);
    if (!scene || scene.revision !== job.base_revision || hash(scene.definition) !== job.input_sha256)
      throw new CreatorError("Place changed; the saved response cannot be rebased", 409);
    await requireBuildConnections(db, job, session);
    const next = { ...job, status: "validating" as const, execution_token: randomUUID() };
    // Only deterministic validation is scheduled. Raw response, reservation and
    // original provider receipt remain intact; this never authorizes submission.
    await jobs.updateOne({ _id: key, status: "invalid" }, { $set: { status: next.status, execution_token: next.execution_token } }, options);
    return { job: wire(next) };
  });
}
export async function previewPlaceBuild(sid: string, pid: string, id: unknown, layoutOnly = false) {
  const db = await access(sid, pid); if (!isSafeId(id)) throw new CreatorError("Invalid generation job", 400);
  const job = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: `${sid}:${pid}:${id}` });
  if (!job || job.status !== "ready" || !job.result || !job.receipt) throw new CreatorError("No accepted layout result is available", 409);
  await requireBuildConnections(db, job);
  const definition = layoutOnly ? job.result : await assetBuildDefinition(db, job, "mesh", await assetBuildDefinition(db, job, "material"));
  return previewPlaceScene(sid, pid, { base_revision: job.base_revision, definition }, undefined, job.receipt);
}
