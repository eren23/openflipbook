import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "mongodb";
import { withDbTransaction } from "./db";
import { CreatorError } from "./creator-error";
import { assetBackend } from "./mesh-execution";
import { currentMotionStudy, motionSourceImage } from "./motion-source";
import { fenceViewSources, viewHash } from "./place-view-store";
import { motionComparisonPlan } from "./motion-comparison";
import { isSafeId } from "./ids";
import { getStoredBytes, uploadJpeg } from "./r2";
import { meshDownloadUrl } from "./mesh-asset";
import { MAX_MOTION_BYTES, silentMotionVideo } from "./motion-video";
import type { MotionFile, MotionJobDoc, MotionAssetDoc } from "./motion-job";
import type { MotionStudyDoc } from "./motion-study";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const due = () => ({ $or: [{ next_check: { $exists: false } }, { next_check: { $lte: new Date() } }] });
function assertStudyBinding(job: MotionJobDoc, study: MotionStudyDoc) {
  if (job.preparation_sha256 !== study.preparation_sha256 || job.model !== study.preparation.model
    || job.adapter !== study.preparation.adapter || !isDeepStrictEqual(job.parameters, study.preparation.parameters))
    throw new CreatorError("Motion request no longer matches its saved study", 409);
  const plan = motionComparisonPlan(study);
  if (!job.comparison || plan.issues.length || job.comparison.sha256 !== viewHash(plan) || !isDeepStrictEqual(job.comparison.plan, plan))
    throw new CreatorError("Motion comparison contract changed before submission", 409);
}
async function submit(db: Db) {
  const jobs = db.collection<MotionJobDoc>("motion_jobs");
  const candidate = await jobs.findOne({ status: "scheduled", ...due() }, { sort: { created_at: 1, _id: 1 } });
  if (!candidate) return false;
  let source: Awaited<ReturnType<typeof motionSourceImage>> | undefined, invalid = false;
  try {
    const { study } = await currentMotionStudy(db, candidate.session_id, candidate.study_id, candidate.study_sha256);
    assertStudyBinding(candidate, study);
    source = await motionSourceImage(study);
  } catch (e) {
    if (e instanceof CreatorError && [400, 404, 409].includes(e.status)) invalid = true;
    else {
      await jobs.updateOne({ _id: candidate._id, status: "scheduled" }, { $set: { next_check: new Date(Date.now() + 30_000), error: "Motion source storage unavailable; nothing submitted." } });
      return true;
    }
  }
  const token = randomUUID();
  const claimed = await withDbTransaction(async (db, session) => {
    const col = db.collection<MotionJobDoc>("motion_jobs"), options = { session };
    const job = await col.findOne({ _id: candidate._id, status: "scheduled" }, options);
    if (!job) return null;
    try {
      if (invalid) throw new CreatorError("Motion source invalid", 409);
      const { study, view } = await currentMotionStudy(db, job.session_id, job.study_id, job.study_sha256, session);
      assertStudyBinding(job, study);
      await fenceViewSources(db, view, session);
    } catch (e) {
      if (!(e instanceof CreatorError) || ![400, 404, 409].includes(e.status)) throw e;
      for (const id of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -job.reservation } }, options);
      await col.updateOne({ _id: job._id }, { $set: { status: "cancelled", error: "Motion source changed before submission; reservation released." } }, options);
      return null;
    }
    return col.findOneAndUpdate({ _id: job._id, status: "scheduled" }, { $set: { status: "submitting", submission_token: token,
      submission_deadline: new Date(Date.now() + 120_000) } }, { ...options, returnDocument: "after" });
  });
  if (!claimed) return true;
  // Submission claims never expire back into scheduled. Only reads/storage use
  // reclaimable leases; ambiguity is visible and cannot create a second POST.
  const authorized = await jobs.findOneAndUpdate({ _id: claimed._id, status: "submitting", submission_token: token,
    submission_started_at: { $exists: false }, submission_deadline: { $gt: new Date() } }, { $set: { submission_started_at: new Date() } }, { returnDocument: "after" });
  if (!authorized) return true;
  try {
    const result = await assetBackend("motion", "submit", { model: claimed.model, adapter: claimed.adapter, purpose: "calibration",
      reservation: claimed.reservation, parameters: claimed.parameters, source });
    if (!isSafeId(result?.request_id) || result.request_id.length > 100 || result.model !== claimed.model) throw new Error("Invalid motion submission receipt");
    await jobs.updateOne({ _id: claimed._id, submission_token: token }, { $set: { request_id: result.request_id } });
    await jobs.updateOne({ _id: claimed._id, submission_token: token, status: { $in: ["submitting", "submission_unknown"] } },
      { $set: { status: "queued", next_check: new Date() }, $unset: { error: "" } });
  } catch {
    await jobs.updateOne({ _id: claimed._id, status: "submitting", submission_token: token },
      { $set: { status: "submission_unknown", error: "Submission response lost. It may be billable; no automatic resubmission." } });
  }
  return true;
}
// Stored bytes, or null when missing or changed. `bytes` is optional for pins that only kept a hash.
export async function verified(file?: { key: string; sha256: string; bytes?: number }) {
  if (!file) return null;
  const value = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  return value && (file.bytes === undefined || value.bytes.length === file.bytes) && hash(value.bytes) === file.sha256 ? value.bytes : null;
}
export async function download(url: string) {
  const response = await fetch(meshDownloadUrl(url), { redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_MOTION_BYTES) throw new Error("Motion download unavailable or too large");
  const chunks: Uint8Array[] = [], reader = response.body.getReader(); let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_MOTION_BYTES) { await reader.cancel(); throw new Error("Motion video too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function store(db: Db, job: MotionJobDoc, token: string) {
  const jobs = db.collection<MotionJobDoc>("motion_jobs"), guard = { _id: job._id, status: "storing" as const, work_token: token };
  try {
    if (!job.provider_result || !job.request_id) throw new Error("Motion result receipt missing");
    let original = await verified(job.original);
    const existingOriginal = !!original;
    if (!original) {
      let result = job.provider_result;
      if (job.refresh_result) {
        result = await assetBackend("motion", `requests/${encodeURIComponent(job.request_id)}`);
        if (result?.status !== "ready" || !result.video?.url) throw new Error("Provider result unavailable");
        if (!(await jobs.updateOne(guard, { $set: { provider_result: result }, $unset: { refresh_result: "" } })).matchedCount) return;
      }
      original = await download(result.video.url);
    }
    const identity = (variant: string, bytes: Buffer): MotionFile => ({ key: `${job.session_id}/motion-videos/${job.id}/${variant}-${hash(bytes)}.mp4`, sha256: hash(bytes), bytes: bytes.length });
    const originalFile = job.original ?? identity("original", original);
    if (originalFile.sha256 !== hash(original) || originalFile.bytes !== original.length) throw new Error("Provider changed original video bytes");
    if (!(await jobs.updateOne(guard, { $set: { original: originalFile } })).matchedCount) return;
    if (!existingOriginal) await uploadJpeg(originalFile.key, original, "video/mp4", AbortSignal.timeout(90_000));
    // Preserve original bytes before decoding, including failed model output.
    let silent = await verified(job.silent), media = job.media;
    if (!silent || !media) {
      const processed = await silentMotionVideo(original); silent = processed.bytes; media = processed.media;
    }
    const silentFile = job.silent ?? identity("silent", silent);
    if (silentFile.sha256 !== hash(silent) || silentFile.bytes !== silent.length) throw new Error("Silent derivative identity changed");
    if (!(await jobs.updateOne(guard, { $set: { silent: silentFile, media } })).matchedCount) return;
    await uploadJpeg(silentFile.key, silent, "video/mp4", AbortSignal.timeout(90_000));
    const assetId = `motion_${job.id}`;
    const asset: MotionAssetDoc = { _id: `${job.session_id}:${assetId}`, id: assetId, session_id: job.session_id, study_id: job.study_id,
      study_sha256: job.study_sha256, preparation_sha256: job.preparation_sha256, model: job.model, adapter: job.adapter,
      request_id: job.request_id, parameters: job.parameters, expanded_prompt: job.provider_result.expanded_prompt ?? null,
      original: originalFile, silent: silentFile, media, ...(job.comparison ? { comparison: job.comparison } : {}), created_at: new Date() };
    await withDbTransaction(async (db, session) => {
      const col = db.collection<MotionJobDoc>("motion_jobs"), options = { session };
      if (!await col.findOne(guard, options)) return;
      const assets = db.collection<MotionAssetDoc>("motion_assets"), existing = await assets.findOne({ _id: asset._id }, options);
      if (existing && (existing.original.sha256 !== asset.original.sha256 || existing.silent.sha256 !== asset.silent.sha256)) throw new Error("Motion asset identity conflict");
      await assets.updateOne({ _id: asset._id }, { $setOnInsert: asset }, { ...options, upsert: true });
      await col.updateOne(guard, { $set: { status: "ready", asset_id: assetId }, $unset: { error: "", work_token: "", work_until: "", refresh_result: "" } }, options);
    });
  } catch {
    await jobs.updateOne(guard, { $set: { status: "storage_failed", error: "Motion storage or video validation failed. Retry storage retrieves the existing request; it does not generate again." }, $unset: { work_token: "", work_until: "" } });
  }
}
async function poll(db: Db) {
  const jobs = db.collection<MotionJobDoc>("motion_jobs"), token = randomUUID(), now = new Date();
  const job = await jobs.findOneAndUpdate({ status: { $in: ["queued", "running", "storing", "submitting", "submission_unknown"] }, request_id: { $exists: true },
    $and: [due(), { $or: [{ work_until: { $exists: false } }, { work_until: { $lt: now } }] }] },
  { $set: { work_token: token, work_until: new Date(Date.now() + 600_000) } }, { sort: { next_check: 1, created_at: 1 }, returnDocument: "after" });
  if (!job) return false;
  const guard = { _id: job._id, status: job.status, work_token: token };
  try {
    const result = job.provider_result ?? await assetBackend("motion", `requests/${encodeURIComponent(job.request_id!)}`);
    if (["queued", "running", "failed"].includes(result?.status)) {
      await jobs.updateOne(guard, { $set: { status: result.status, next_check: new Date(Date.now() + 5000),
        ...(result.status === "failed" ? { error: "Provider rejected this clip. No automatic resubmission." } : {}) },
      $unset: { work_token: "", work_until: "", ...(result.status !== "failed" ? { error: "" } : {}) } });
    } else if (result?.status === "ready" && typeof result.video?.url === "string") {
      const saved = await jobs.findOneAndUpdate(guard, { $set: { status: "storing", provider_result: result } }, { returnDocument: "after" });
      if (saved) await store(db, saved, token);
    } else throw new Error("Invalid motion state");
  } catch {
    await jobs.updateOne(guard, { $set: { next_check: new Date(Date.now() + 30_000), error: "Motion provider unavailable; the existing request will be checked again." }, $unset: { work_token: "", work_until: "" } });
  }
  return true;
}
export async function processNextMotionJob(db: Db) {
  await db.collection<MotionJobDoc>("motion_jobs").updateMany({ status: "submitting", submission_deadline: { $lt: new Date() } },
    { $set: { status: "submission_unknown", error: "Submission was interrupted; no automatic resubmission." } });
  if (await poll(db)) return true;
  return submit(db);
}
