import { createHash, randomUUID } from "node:crypto";
import type { Db, Filter } from "mongodb";
import { withDbTransaction } from "./db";
import { modalAuthHeaders, modalUrl } from "./modal";
import { getStoredBytes, uploadJpeg } from "./r2";
import { isSafeId } from "./ids";
import { meshDownloadUrl, MESH_IMAGE_MODEL, type MeshJob } from "./mesh-asset";
import { prepareMeshInput } from "./mesh-source";
import { assetPipeline, validateAssetBytes, type AssetKind } from "./asset-pipeline";
import type { SceneDoc } from "./place-scene-store";
import type { BuildDoc } from "./place-build-execution";
import { CreatorError } from "./creator-error";
import { illustrationEditSource, illustrationSource, keyframeChainSource, keyframeJobPasses, prepareIllustrationInput, prepareKeyframeViewInput } from "./illustration-input";
import type { KeyframeGateDoc, MeshAssetDoc, MeshJobDoc } from "./mesh-docs";
export type { MeshAssetDoc, MeshJobDoc } from "./mesh-docs";
import { fenceViewSources } from "./place-view-store";
import { ILLUSTRATION_EDIT_MODEL, KEYFRAME_MODEL } from "./asset-pipeline";
import { registeredPixels } from "./illustration-region";
import { buildConnectionsCurrent } from "./place-build-connections";
import { usesIllustrationIdentity } from "./illustration-identity";
import { finishKeyframe, keyframeGateBody, type KeyframePasses } from "./illustration-keyframe-server";
import type { IllustrationKeyframe } from "./place-view";

const statusPath = (job: MeshJobDoc) => `requests/${encodeURIComponent(job.request_id!)}${[ILLUSTRATION_EDIT_MODEL, KEYFRAME_MODEL, MESH_IMAGE_MODEL].includes(job.model) ? `?model=${encodeURIComponent(job.model)}` : ""}`;
export const wireMesh = (job: MeshJobDoc): MeshJob => ({ id: job.id, prompt: job.prompt, model: job.model, status: job.status, reservation: job.reservation,
  ...(job.asset_id ? { asset_id: job.asset_id } : {}), ...(job.source_id ? { source_id: job.source_id } : {}), ...(job.error ? { error: job.error } : {}) });
export async function assetBackend(kind: AssetKind | "motion", path: string, body?: unknown, timeout = 90_000, limit = 100_000) {
  if (!process.env.MODAL_API_URL) throw new Error("3D backend is not configured");
  const response = await fetch(modalUrl(process.env.MODAL_API_URL, `/${kind}/${path}`), { method: body ? "POST" : "GET", redirect: "error",
    headers: { "Content-Type": "application/json", ...modalAuthHeaders() }, ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!response.ok) throw new Error(`3D provider returned ${response.status}`);
  const text = await response.text(); if (text.length > limit) throw new Error("3D response too large");
  return JSON.parse(text);
}
export async function assetWorkerAvailable(db: Db, kind: AssetKind, region = false, image = false, brush = false, identity = false, keyframe = false) {
  // Older workers share this queue and cannot prepare image inputs. Require a
  // completed worker rollout before exposing the new paid capability.
  if (image && await db.collection("generation_workers").findOne({ kind: "place-layout", mesh: true, mesh_image: { $ne: true }, last_seen: { $gt: new Date(Date.now() - 30_000) } })) return false;
  if (brush && await db.collection("generation_workers").findOne({ kind: "place-layout", illustration: true, illustration_brush: { $ne: true }, last_seen: { $gt: new Date(Date.now() - 30_000) } })) return false;
  if (identity && await db.collection("generation_workers").findOne({ kind: "place-layout", illustration: true, illustration_identity: { $ne: true }, last_seen: { $gt: new Date(Date.now() - 30_000) } })) return false;
  if (keyframe && await db.collection("generation_workers").findOne({ kind: "place-layout", illustration: true, illustration_keyframe: { $ne: true }, last_seen: { $gt: new Date(Date.now() - 30_000) } })) return false;
  return !!await db.collection("generation_workers").findOne({ kind: "place-layout", [kind]: true, ...(region ? { illustration_region: true } : {}), ...(image ? { mesh_image: true } : {}), ...(brush ? { illustration_brush: true } : {}), ...(identity ? { illustration_identity: true } : {}), ...(keyframe ? { illustration_keyframe: true } : {}), last_seen: { $gt: new Date(Date.now() - 30_000) } });
}
export async function expireAssetSubmissions(db: Db, kind: AssetKind, session_id?: string) {
  const scope = session_id ? { session_id } : {};
  // Legacy request-bound submissions have no deadline. Their creation time is
  // the conservative fallback; neither branch authorizes resubmission.
  await db.collection<MeshJobDoc>(`${kind}_jobs`).updateMany({ ...scope, status: "submitting", $or: [
    { submission_deadline: { $lt: new Date() } },
    { submission_deadline: { $exists: false }, created_at: { $lt: new Date(Date.now() - 120_000) } },
  ] }, { $set: { status: "submission_unknown", error: "Submission was interrupted. It may be billable; no automatic retry will be submitted." } });
}

async function submitScheduledAsset(db: Db, kind: AssetKind) {
  const col = db.collection<MeshJobDoc>(`${kind}_jobs`), token = randomUUID();
  let prepared: Record<string, unknown> | undefined;
  let imageInput: string | undefined;
  let candidate: MeshJobDoc | null = null;
  let invalidInput = false;
  if (kind === "illustration" || kind === "mesh") {
    candidate = await col.findOne({ status: "scheduled", $or: [{ next_check: { $exists: false } }, { next_check: { $lte: new Date() } }] }, { sort: { created_at: 1, _id: 1 } });
    if (!candidate) return false;
    try {
      if (kind === "mesh") {
        if ((candidate.model === MESH_IMAGE_MODEL) !== !!candidate.image_input) throw new CreatorError("Mesh input is missing or incompatible", 409);
        if (candidate.image_input) {
          if (candidate.image_input.session_id !== candidate.session_id || candidate.source_id !== candidate.image_input.id) throw new CreatorError("Mesh source ownership mismatch", 409);
          imageInput = await prepareMeshInput(candidate.image_input);
        }
      } else {
        if (!candidate.view_dependency) throw new CreatorError("Illustration has no saved view dependency", 409);
        if ((candidate.model === ILLUSTRATION_EDIT_MODEL) !== !!candidate.edit_input) throw new CreatorError("Illustration edit input is missing or incompatible", 409);
        if ((candidate.model === KEYFRAME_MODEL) !== !!candidate.keyframe_input) throw new CreatorError("Keyframe input is missing or incompatible", 409);
        prepared = candidate.keyframe_input ? (await prepareKeyframeViewInput(db, candidate.session_id, candidate.view_dependency, candidate.keyframe_input)).inputs
          : await prepareIllustrationInput(db, candidate.session_id, candidate.view_dependency, candidate.edit_input, usesIllustrationIdentity(candidate.parameters));
      }
    } catch (error) {
      if (error instanceof CreatorError && error.status === 409) invalidInput = true;
      else {
        // Input reads precede the paid claim. Storage outages remain unsubmitted
        // and cancellable, with a backoff rather than an ambiguous paid state.
        await col.updateOne({ _id: candidate._id, status: "scheduled" }, { $set: { next_check: new Date(Date.now() + 30_000), error: "Saved input unavailable. Waiting for storage; no generation submitted." } });
        return true;
      }
    }
  }
  // Atomic claim immediately precedes the only POST. It is never re-leased.
  const job = await withDbTransaction(async (db, session) => {
    const jobs = db.collection<MeshJobDoc>(`${kind}_jobs`), options = { session };
    const pending = await jobs.findOne({ status: "scheduled", ...(candidate ? { _id: candidate._id } : {}) }, { ...options, sort: { created_at: 1, _id: 1 } });
    if (!pending) return null;
    if (kind === "mesh" && invalidInput) {
      for (const id of pending.ledger_ids ?? []) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -pending.reservation } }, options);
      await jobs.updateOne({ _id: pending._id }, { $set: { status: "cancelled", error: "Concept input invalid before submission; reservation released." } }, options);
      return null;
    }
    if (kind === "illustration") {
      try {
        if (invalidInput || !pending.view_dependency) throw new CreatorError("Illustration source changed", 409);
        const view = await illustrationSource(db, pending.session_id, pending.view_dependency, session);
        if (pending.edit_input) await illustrationEditSource(db, pending.session_id, view, pending.edit_input, session);
        if (pending.keyframe_input?.chain_from) await keyframeChainSource(db, pending.session_id, pending.keyframe_input.chain_from, true, session);
        await fenceViewSources(db, view, session);
      } catch (error) {
        if (!(error instanceof CreatorError) || error.status !== 409) throw error;
        for (const id of pending.ledger_ids ?? []) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -pending.reservation } }, options);
        await jobs.updateOne({ _id: pending._id }, { $set: { status: "cancelled", error: "Illustration source changed before submission; reservation released." } }, options);
        return null;
      }
    }
    if (pending.dependency) {
      const d = pending.dependency;
      const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${pending.session_id}:${d.place_id}` }, options);
      const build = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: d.build_key, session_id: pending.session_id, status: "ready" }, options);
      const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
      const plan = kind === "mesh" ? build?.mesh_plan : build?.material_plan;
      if ((d.kind ?? "material") !== kind || !scene || scene.revision !== d.revision || hash(scene.definition) !== d.input_sha256 || !build?.result || !plan || hash(build.result) !== d.result_sha256 || hash(plan) !== d.plan_sha256
        || d.connections_sha256 !== build.connections_sha256 || !await buildConnectionsCurrent(db, build, session)) {
        for (const id of pending.ledger_ids ?? []) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -pending.reservation } }, options);
        await jobs.updateOne({ _id: pending._id }, { $set: { status: "cancelled", error: "Build dependency changed before submission; reservation released." } }, options);
        return null;
      }
    }
    return jobs.findOneAndUpdate({ _id: pending._id, status: "scheduled" }, { $set: { status: "submitting", submission_token: token, submission_deadline: new Date(Date.now() + 120_000) } },
      { ...options, returnDocument: "after" });
  });
  if (!job) return false;
  const authorized = await col.findOneAndUpdate({ _id: job._id, status: "submitting", submission_token: token,
    submission_deadline: { $gt: new Date() }, submission_started_at: { $exists: false } },
  { $set: { submission_started_at: new Date() } }, { returnDocument: "after" });
  if (!authorized) return true;
  try {
    const result = await assetBackend(kind, "submit", { prompt: job.prompt, model: job.model, reservation: job.reservation, parameters: job.parameters, ...(prepared ? { inputs: prepared } : {}), ...(imageInput ? { input_image_url: imageInput } : {}) });
    if (!isSafeId(result?.request_id) || result.request_id.length > 100 || result.model !== job.model) throw new Error("Missing provider request id");
    // A late ID is retained even after cancellation, but cancellation remains terminal.
    await col.updateOne({ _id: job._id, submission_token: token }, { $set: { request_id: result.request_id } });
    await col.updateOne({ _id: job._id, submission_token: token, status: { $in: ["submitting", "submission_unknown"] } },
      { $set: { status: "queued", next_check: new Date() }, $unset: { error: "" } });
  } catch {
    await col.updateOne({ _id: job._id, submission_token: token, status: "submitting" }, { $set: { status: "submission_unknown", error: "Submission was interrupted. It may be billable; no automatic retry will be submitted." } });
  }
  return true;
}

async function downloadAsset(kind: AssetKind, url: unknown) {
  const limit = assetPipeline(kind).maxBytes;
  const response = await fetch(meshDownloadUrl(url), { redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) throw new Error("Generated asset download failed or exceeds its size limit");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error("Generated asset exceeds its size limit"); } chunks.push(value); }
  return Buffer.concat(chunks);
}

const WORK_LEASE_MS = 360_000;
// The gate runs at most once per job. "started" is saved before the call and
// the result (or an outage) before any download, so a crash or a storage
// retry never segments the same candidates again.
async function gateKeyframe(db: Db, job: MeshJobDoc, token: string, passes: KeyframePasses, urls: string[]): Promise<KeyframeGateDoc> {
  const col = db.collection<MeshJobDoc>("illustration_jobs"), lease = { _id: job._id, status: "storing" as const, work_token: token };
  if (job.keyframe_gate && job.keyframe_gate.status !== "started") return job.keyframe_gate;
  let gate: KeyframeGateDoc = { status: "outage" };
  if (!job.keyframe_gate) {
    // A fresh lease covers the gate call, whatever the reads before it took.
    if (!await col.findOneAndUpdate({ ...lease, keyframe_gate: { $exists: false } }, { $set: { keyframe_gate: { status: "started" }, work_until: new Date(Date.now() + WORK_LEASE_MS) } })) throw new Error("Keyframe gate lease lost");
    const body = await keyframeGateBody(passes, job.keyframe_input!.gate_object_id, urls);
    if (!body) gate = { status: "no_building" };
    else try {
      // SAM-3 may take 180 s for two candidates; each mask is a small PNG.
      const masks = (await assetBackend("illustration", "gate", body, 200_000, 2_000_000))?.masks;
      if (Array.isArray(masks) && masks.length === urls.length && masks.every(m => m && (m.mask_png === null || typeof m.mask_png === "string"))) gate = { status: "measured", masks: masks.map(m => m.mask_png) };
    } catch { /* An outage keeps candidate 0, unmeasured. */ }
  }
  if (!await col.findOneAndUpdate(lease, { $set: { keyframe_gate: gate } })) throw new Error("Keyframe gate lease lost");
  return gate;
}
async function finishKeyframeJob(db: Db, job: MeshJobDoc, token: string, response: NonNullable<MeshJobDoc["provider_result"]>): Promise<{ bytes: Buffer; keyframe: IllustrationKeyframe }> {
  const input = job.keyframe_input!, urls = (response.images ?? [response.image]).map(image => meshDownloadUrl(image?.url));
  const { passes, chain } = await keyframeJobPasses(db, job.session_id, job.view_dependency!, input);
  const gate = await gateKeyframe(db, job, token, passes, urls);
  const candidates: Buffer[] = [];
  for (const url of urls) candidates.push(await downloadAsset("illustration", url));
  const { bytes, chain: warp, ...result } = await finishKeyframe(passes, input.gate_object_id, candidates, gate.status === "measured" ? gate.masks : null, chain);
  const { chain_from, gate_object_id, ...request } = input;
  return { bytes, keyframe: { version: 1, ...request, ...(chain_from && warp ? { chain_from: { ...chain_from, angle: warp.angle, hole_share: warp.hole_share } } : {}), object_id: gate_object_id, ...result } };
}

async function storeAsset(db: Db, kind: AssetKind, job: MeshJobDoc, token: string) {
  const col = db.collection<MeshJobDoc>(`${kind}_jobs`), spec = assetPipeline(kind);
  try {
    if (!job.request_id || !job.provider_result) throw new Error("Saved provider result is missing");
    let bytes: Buffer | undefined, alreadyStored = false, keyframe = job.keyframe_result;
    if (job.download) {
      const saved = await getStoredBytes(job.download.key, AbortSignal.timeout(30_000));
      if (saved && saved.bytes.length === job.download.bytes && createHash("sha256").update(saved.bytes).digest("hex") === job.download.sha256) {
        bytes = saved.bytes; alreadyStored = true;
      }
    }
    if (!bytes) {
      let response = job.provider_result;
      if (job.refresh_result) {
        const fresh = await assetBackend(kind, statusPath(job));
        if (fresh?.status !== "ready") throw new Error("Provider asset is not currently available");
        response = fresh;
        await col.updateOne({ _id: job._id, status: "storing", work_token: token }, { $set: { provider_result: fresh }, $unset: { refresh_result: "" } });
      }
      if (job.keyframe_input) ({ bytes, keyframe } = await finishKeyframeJob(db, job, token, response));
      else bytes = await downloadAsset(kind, kind === "mesh" ? response.model_glb?.url : response.image?.url);
    }
    const metadata = validateAssetBytes(kind, bytes);
    if (kind === "illustration" && (!job.view_dependency || metadata.illustration?.width !== job.view_dependency.width || metadata.illustration?.height !== job.view_dependency.height)) throw new Error("Generated illustration dimensions differ from the saved camera");
    if (kind === "illustration") await registeredPixels(bytes, job.view_dependency!.width, job.view_dependency!.height);
    const hash = createHash("sha256").update(bytes).digest("hex"), assetId = `${kind}_${job.id}`;
    if (job.download && (job.download.sha256 !== hash || job.download.bytes !== bytes.length)) throw new Error("Provider changed the saved asset bytes");
    const download = job.download ?? { key: `${job.session_id}/${kind === "mesh" ? "meshes" : kind === "material" ? "materials" : "illustrations"}/${assetId}/${hash}.${spec.extension}`, sha256: hash, bytes: bytes.length };
    const current = await col.findOneAndUpdate({ _id: job._id, status: "storing", work_token: token }, { $set: { download, ...(keyframe ? { keyframe_result: keyframe } : {}) } }, { returnDocument: "after" });
    if (!current) return;
    if (!alreadyStored) await uploadJpeg(download.key, bytes, spec.contentType, AbortSignal.timeout(90_000));
    const asset: MeshAssetDoc = { _id: `${job.session_id}:${assetId}`, id: assetId, session_id: job.session_id, ...download, ...metadata,
      model: job.model, prompt: job.prompt, request_id: job.request_id, created_at: new Date(), ...(job.parameters ? { parameters: job.parameters } : {}), ...(job.dependency ? { dependency: job.dependency } : {}), ...(job.view_dependency ? { view_dependency: job.view_dependency } : {}), ...(job.edit_input ? { edit_input: job.edit_input } : {}), ...(keyframe ? { keyframe } : {}), ...(job.image_input ? { image_input: job.image_input } : {}) };
    // Asset publication and job completion are one transaction. A cancelled job
    // can leave an unreferenced blob, but cannot expose it in the asset library.
    await withDbTransaction(async (db, session) => {
      const jobs = db.collection<MeshJobDoc>(`${kind}_jobs`), options = { session };
      if (!await jobs.findOne({ _id: job._id, status: "storing", work_token: token }, options)) return;
      const assets = db.collection<MeshAssetDoc>(`${kind}_assets`);
      const existing = await assets.findOne({ _id: asset._id }, options);
      if (existing && existing.sha256 !== hash) throw new Error("Saved asset identity conflict");
      await assets.updateOne({ _id: asset._id }, { $setOnInsert: asset }, { ...options, upsert: true });
      await jobs.updateOne({ _id: job._id, status: "storing", work_token: token }, { $set: { status: "ready", asset_id: assetId }, $unset: { error: "", work_token: "", work_until: "", refresh_result: "" } }, options);
    });
  } catch (e) {
    await col.updateOne({ _id: job._id, status: "storing", work_token: token }, { $set: { status: "storage_failed", error: `Asset storage failed: ${(e as Error).message}. Retry storage does not generate again.`.slice(0, 500) }, $unset: { work_token: "", work_until: "" } });
  }
}

async function pollOrStoreAsset(db: Db, kind: AssetKind) {
  const col = db.collection<MeshJobDoc>(`${kind}_jobs`), now = new Date(), token = randomUUID();
  const claim: Filter<MeshJobDoc> = { status: { $in: ["queued", "running", "storing", "submission_unknown", "submitting"] },
    request_id: { $exists: true }, $and: [
      { $or: [{ next_check: { $exists: false } }, { next_check: { $lte: now } }] },
      { $or: [{ work_until: { $exists: false } }, { work_until: { $lt: now } }] },
    ] };
  // Read/download leases may expire and be reclaimed; the saved request ID
  // makes recovery a non-generative operation. Tokens fence late writers.
  const job = await col.findOneAndUpdate(claim, { $set: { work_token: token, work_until: new Date(Date.now() + WORK_LEASE_MS) } },
    { sort: { next_check: 1, created_at: 1, _id: 1 }, returnDocument: "after" });
  if (!job) return false;
  if (job.provider_result) {
    const saved = await col.findOneAndUpdate({ _id: job._id, work_token: token, status: job.status }, { $set: { status: "storing" } }, { returnDocument: "after" });
    if (saved) await storeAsset(db, kind, saved, token);
    return true;
  }
  try {
    const result = await assetBackend(kind, statusPath(job));
    if (["queued", "running", "failed"].includes(result?.status)) {
      await col.updateOne({ _id: job._id, status: job.status, work_token: token }, {
        $set: { status: result.status, next_check: new Date(Date.now() + 5000), ...(result.status === "failed" ? { error: "The provider rejected this generation. No automatic retry was submitted." } : {}) },
        $unset: { work_token: "", work_until: "", ...(result.status !== "failed" ? { error: "" } : {}) },
      });
    } else if (result?.status === "ready") {
      const saved = await col.findOneAndUpdate({ _id: job._id, status: job.status, work_token: token },
        { $set: { status: "storing", provider_result: result }, $unset: { error: "", refresh_result: "" } }, { returnDocument: "after" });
      if (saved) await storeAsset(db, kind, saved, token);
    } else throw new Error("Unknown 3D provider state");
  } catch {
    await col.updateOne({ _id: job._id, status: job.status, work_token: token }, { $set: { next_check: new Date(Date.now() + 30_000), error: "Provider status unavailable. The saved request will be checked again; no new generation is submitted." }, $unset: { work_token: "", work_until: "" } });
  }
  return true;
}

export async function processNextAssetJob(db: Db, kind: AssetKind) {
  await expireAssetSubmissions(db, kind);
  // Alternate at the runner level with layout work. Prefer finishing existing
  // assets, but each poll sets its next-check time so new submissions can run.
  if (await pollOrStoreAsset(db, kind)) return true;
  return submitScheduledAsset(db, kind);
}

export const meshBackend = (path: string, body?: unknown) => assetBackend("mesh", path, body);
export const meshWorkerAvailable = (db: Db) => assetWorkerAvailable(db, "mesh");
export const expireMeshSubmissions = (db: Db, sid?: string) => expireAssetSubmissions(db, "mesh", sid);
export const processNextMeshJob = (db: Db) => processNextAssetJob(db, "mesh");
