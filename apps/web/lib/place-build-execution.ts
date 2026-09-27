import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { PlaceBuildConnectionInput, PlaceSceneDefinition, SceneGenerationReceipt } from "@openflipbook/config";
import { withDbTransaction } from "./db";
import { modalAuthHeaders, modalUrl } from "./modal";
import { acceptPlacePlan, type PlaceBuildJob } from "./place-build";
import type { SceneDoc } from "./place-scene-store";
import { acceptMaterialPlan, type PlannedMaterial } from "./place-build-materials";
import { acceptMeshPlan, type PlannedMesh } from "./place-build-meshes";
import { buildConnectionsCurrent } from "./place-build-connections";
import type { AssetQuote } from "./asset-pipeline";

export interface PlannerResponse {
  status: "ready" | "invalid";
  model: string;
  request_id?: string;
  result?: unknown;
  usage?: unknown;
}
export interface BuildDoc extends PlaceBuildJob {
  _id: string; session_id: string; place_id: string;
  input: PlaceSceneDefinition; input_sha256: string;
  connection_input?: PlaceBuildConnectionInput; connections_sha256?: string;
  expansion?: { source_place_id: string; proposal_id: string };
  appearance_approval?: NonNullable<PlaceBuildJob["appearance_approval"]> & { quotes: Partial<Record<"material" | "mesh", AssetQuote>> };
  ledger_ids: string[]; deadline?: Date; execution_token?: string; received_at?: string; submission_started_at?: Date;
  provider_response?: PlannerResponse;
  result?: PlaceSceneDefinition; receipt?: SceneGenerationReceipt;
}
export interface PlaceBuildWorkerDoc { _id: string; kind: "place-layout"; last_seen: Date; mesh?: boolean; material?: boolean; illustration?: boolean; motion_v1?: boolean; motion_review_v1?: boolean; layout_connections?: boolean; layout_floor_targets?: boolean }
export const buildInputHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const interruptedBuild = "Planning was interrupted. It may be billable; no automatic retry will be submitted.";

export async function placeBuildBackend(path: string, body?: unknown) {
  if (!process.env.MODAL_API_URL) throw new Error("Layout backend is not configured");
  const response = await fetch(modalUrl(process.env.MODAL_API_URL, `/place-build/${path}`), {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...modalAuthHeaders() },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(body ? 170_000 : 10_000),
  });
  if (!response.ok) throw new Error(`Layout backend returned ${response.status}`);
  const text = await response.text();
  if (text.length > 500_000) throw new Error("Layout response is too large");
  return JSON.parse(text);
}

export async function placeBuildWorkerAvailable(db: Db, connections = false, floorTargets = false) {
  const workers = await db.collection<PlaceBuildWorkerDoc>("generation_workers").find({ kind: "place-layout", last_seen: { $gt: new Date(Date.now() - 30_000) } }).toArray();
  return workers.length > 0 && (!connections || workers.every(w => w.layout_connections === true)) && (!floorTargets || workers.every(w => w.layout_floor_targets === true));
}

export async function expirePlaceBuilds(db: Db, scope: { session_id?: string; place_id?: string } = {}) {
  // A read timeout is not a submission failure. Only the persisted execution
  // deadline changes the observed state, and never authorizes another call.
  await db.collection<BuildDoc>("place_build_jobs").updateMany({ ...scope, status: "planning", deadline: { $lt: new Date() } },
    { $set: { status: "submission_unknown", error: interruptedBuild } });
}

export async function claimPlaceBuild() {
  return withDbTransaction(async (db, session) => {
    const col = db.collection<BuildDoc>("place_build_jobs"), options = { session };
    const job = await col.findOne({ status: "scheduled" }, { ...options, sort: { created_at: 1, _id: 1 } });
    if (!job) return null;
    const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${job.session_id}:${job.place_id}` }, options);
    if (!scene || scene.revision !== job.base_revision || buildInputHash(scene.definition) !== job.input_sha256 || !await buildConnectionsCurrent(db, job, session)) {
      for (const ledgerId of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: ledgerId }, { $inc: { total: -job.reservation } }, options);
      await col.updateOne({ _id: job._id, status: "scheduled" }, { $set: { status: "cancelled", error: "Place or connections changed before submission; reservation released." } }, options);
      return null;
    }
    // The claim is committed BEFORE network I/O. An expired claim is never
    // leased to another worker: the provider may already have charged it.
    const claimed = { ...job, status: "planning", execution_token: randomUUID(), deadline: new Date(Date.now() + 180_000) } satisfies BuildDoc;
    await col.updateOne({ _id: job._id, status: "scheduled" }, { $set: { status: claimed.status, execution_token: claimed.execution_token, deadline: claimed.deadline } }, options);
    return claimed;
  });
}

export async function finalizePlaceBuild(db: Db, job: BuildDoc) {
  if (job.status !== "validating") return;
  if (!job.provider_response || !job.execution_token) {
    await db.collection<BuildDoc>("place_build_jobs").updateOne({ _id: job._id, status: "validating" },
      { $set: { status: "submission_unknown", error: "Saved planner response is incomplete. No automatic retry will be submitted; reservation retained." } });
    return;
  }
  const response = job.provider_response;
  const receipt: SceneGenerationReceipt = { job_id: job.id, model: job.model, request_id: typeof response.request_id === "string" ? response.request_id.slice(0, 200) : null,
    prompt: job.prompt, base_revision: job.base_revision, input_sha256: job.input_sha256, object_ids: [], reserved_usd: job.reservation, created_at: job.received_at ?? job.created_at,
    ...(job.connection_input && job.connections_sha256 ? { connection_input: job.connection_input, connections_sha256: job.connections_sha256 } : {}), ...(job.target_floor ? { target_floor: job.target_floor } : {}) };
  let result: PlaceSceneDefinition | undefined, error: string | undefined;
  let material_plan: PlannedMaterial[] = [];
  let mesh_plan: PlannedMesh[] = [];
  try {
    if (response.status !== "ready" || response.model !== job.model) throw new Error("Model response was incomplete or invalid. No repair call was submitted.");
    const accepted = acceptPlacePlan(job.input, response.result, job.id, job.connection_input, job.target_floor);
    const raw = response.result as { objects: { id: string }[]; materials?: unknown; meshes?: unknown };
    material_plan = acceptMaterialPlan(raw.materials, raw.objects.map(o => o.id), accepted.objects.slice(job.input.objects.length), job.input.objects.length === 0 && !job.input.ground_material);
    mesh_plan = acceptMeshPlan(raw.meshes, raw.objects.map(o => o.id), accepted.objects.slice(job.input.objects.length));
    result = accepted;
    receipt.object_ids = result.objects.slice(job.input.objects.length).map(o => o.id);
  } catch (e) { error = `Layout rejected: ${(e as Error).message}`.slice(0, 500); }
  // Deterministic validation is replayable. A database failure here leaves the
  // raw response recoverable instead of misclassifying it as invalid geometry.
  await db.collection<BuildDoc>("place_build_jobs").updateOne({ _id: job._id, status: "validating", execution_token: job.execution_token }, {
    $set: result ? { status: "ready", result, receipt, material_plan, mesh_plan } : { status: "invalid", receipt, error: error ?? "Layout rejected" },
    ...(result ? { $unset: { error: "" } } : {}),
  });
}

export async function executePlaceBuild(db: Db, job: BuildDoc) {
  if (!job.execution_token) return;
  const col = db.collection<BuildDoc>("place_build_jobs");
  const authorized = await col.findOneAndUpdate({ _id: job._id, execution_token: job.execution_token, status: "planning",
    deadline: { $gt: new Date() }, submission_started_at: { $exists: false } },
  { $set: { submission_started_at: new Date() } }, { returnDocument: "after" });
  if (!authorized) return;
  try {
    const response = await placeBuildBackend("plan", { prompt: job.prompt, model: job.model, reservation: job.reservation, definition: job.input,
      ...(job.connection_input ? { connection_input: job.connection_input } : {}), ...(job.target_floor ? { target_floor: job.target_floor } : {}) });
    if (!response || response.model !== job.model || !["ready", "invalid"].includes(response.status)) throw new Error("Unrecognized planner response");
    const received_at = new Date().toISOString();
    // Persist the provider result before geometry validation. Cancellation is
    // terminal; a late response can resolve ambiguity but cannot resurrect it.
    await col.updateOne({ _id: job._id, execution_token: job.execution_token, status: { $in: ["planning", "submission_unknown"] } },
      { $set: { status: "validating", provider_response: response, received_at }, $unset: { error: "" } });
    const saved = await col.findOne({ _id: job._id });
    if (saved) await finalizePlaceBuild(db, saved);
  } catch {
    await col.updateOne({ _id: job._id, execution_token: job.execution_token, status: "planning" }, { $set: { status: "submission_unknown", error: interruptedBuild } });
  }
}

export async function processNextPlaceBuild(db: Db) {
  await expirePlaceBuilds(db);
  const saved = await db.collection<BuildDoc>("place_build_jobs").findOne({ status: "validating" }, { sort: { created_at: 1 } });
  if (saved) { await finalizePlaceBuild(db, saved); return true; }
  const job = await claimPlaceBuild();
  if (!job) return false;
  await executePlaceBuild(db, job);
  return true;
}
