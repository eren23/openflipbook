import type { Db } from "mongodb";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { withDbTransaction } from "./db";
import { placeScenesEnabled } from "./place-scene-enabled";
import { assetBackend } from "./mesh-execution";
import { H3_CAMERA_ADAPTER, H3_CAMERA_MODEL } from "./camera-motion";
import { currentMotionStudy, motionSourceImage } from "./motion-source";
import { fenceViewSources, viewHash } from "./place-view-store";
import { reserveGenerationSpend } from "./generation-reservation";
import { wireMotionJob, type MotionJobDoc, type MotionAssetDoc, type MotionReviewDoc } from "./motion-job";
import { motionComparisonPlan, parseMotionReview, evaluateMotionReview } from "./motion-comparison";
import type { MotionStudyDoc } from "./motion-study";
import { createHash } from "node:crypto";
import { getStoredBytes } from "./r2";

async function access(sid: string, studyId: string) {
  if (!isSafeId(studyId)) throw new CreatorError("Invalid motion study id", 400);
  return requireCreator(sid);
}
export async function motionQuote(db: Db, duration: number) {
  const config = await assetBackend("motion", "capabilities"), rate = config.reservation_usd_per_second;
  if (!placeScenesEnabled() || !config.enabled || config.model !== H3_CAMERA_MODEL || config.adapter !== H3_CAMERA_ADAPTER
    || config.purpose !== "calibration" || config.resolution !== "768P" || !Number.isFinite(rate) || rate < .08 || rate > .5
    || !Number.isInteger(duration) || duration < 5 || duration > 15) throw new CreatorError("Motion calibration is not configured", 503);
  const micros = Math.round(rate * 1_000_000);
  if (Math.abs(micros / 1_000_000 - rate) > 1e-12) throw new CreatorError("Motion price precision unsupported", 503);
  if (!await db.collection("generation_workers").findOne({ kind: "place-layout", motion_v1: true, motion_review_v1: true, last_seen: { $gt: new Date(Date.now() - 30_000) } }))
    throw new CreatorError("Compatible motion worker unavailable", 503);
  return { model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER, reservation: micros * duration / 1_000_000 };
}
export async function motionJobLibrary(sid: string, studyId: string) {
  const db = await access(sid, studyId);
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${sid}:${studyId}`, session_id: sid });
  if (!study) throw new CreatorError("Motion study not found", 404);
  const jobs = await db.collection<MotionJobDoc>("motion_jobs").find({ session_id: sid, study_id: studyId }).sort({ created_at: -1 }).limit(20).toArray();
  const assets = await db.collection<MotionAssetDoc>("motion_assets").find({ session_id: sid, study_id: studyId }).sort({ created_at: -1 }).limit(20).toArray();
  const reviews = await db.collection<MotionReviewDoc>("motion_reviews").find({ session_id: sid, study_id: studyId }).sort({ created_at: -1 }).limit(400).toArray();
  const plan = motionComparisonPlan(study), comparison = { plan, sha256: viewHash(plan) };
  const selection = await db.collection<{ _id: string; asset_id: string }>("motion_selections").findOne({ _id: `${sid}:${studyId}` });
  let historical = false, reason = "", quote: Awaited<ReturnType<typeof motionQuote>> | null = null;
  try { await currentMotionStudy(db, sid, studyId); }
  catch (e) { if (!(e instanceof CreatorError) || ![400, 404, 409].includes(e.status)) throw e; historical = true; reason = e.message; }
  if (!historical) {
    try {
      if (study.client_preflight?.status !== "clear") throw new CreatorError("Save a study with a clear local path check", 409);
      if (plan.issues.length) throw new CreatorError(plan.issues[0]!, 409);
      quote = await motionQuote(db, study.preparation.parameters.duration);
    } catch (e) { reason = e instanceof CreatorError ? e.message : "Motion backend unavailable"; }
  }
  return { comparison, reviews: reviews.map(r => ({ id: r.id, asset_id: r.asset_id, review: r.review, outcome: r.outcome })),
    jobs: jobs.map(wireMotionJob), assets: assets.map(a => ({ id: a.id, media: a.media, historical, comparison: a.comparison ?? null,
    ...(a.restored_from ? { imported: true as const } : {}),
    duration_matches: Math.abs(a.media.duration - a.parameters.duration) <= .5 })), accepted_id: selection?.asset_id ?? null,
    study_sha256: viewHash(study), historical, quote, reason };
}
export async function submitMotionJob(sid: string, studyId: string, input: Record<string, unknown>) {
  const db = await access(sid, studyId);
  if (!isSafeId(input.id) || input.id.length > 121 || input.confirmed !== true || input.calibration_confirmed !== true || typeof input.study_sha256 !== "string")
    throw new CreatorError("Explicit priced calibration consent is required", 400);
  const id = input.id, key = `${sid}:${id}`, hash = viewHash(input), same = (job: MotionJobDoc) => {
    if (job.study_id !== studyId || job.request_sha256 !== hash) throw new CreatorError("Motion request identity already used", 409);
    return { job: wireMotionJob(job) };
  };
  const prior = await db.collection<MotionJobDoc>("motion_jobs").findOne({ _id: key, session_id: sid });
  if (prior) return same(prior);
  const { study } = await currentMotionStudy(db, sid, studyId, input.study_sha256);
  if (study.client_preflight?.status !== "clear") throw new CreatorError("A clear local reference check is required for calibration", 409);
  const plan = motionComparisonPlan(study), comparison = { plan, sha256: viewHash(plan) };
  if (plan.issues.length) throw new CreatorError(plan.issues[0]!, 409);
  if (input.comparison_sha256 !== comparison.sha256) throw new CreatorError("Review the current motion comparison criteria", 409);
  await motionSourceImage(study);
  const quote = await motionQuote(db, study.preparation.parameters.duration);
  if (input.reservation !== quote.reservation) throw new CreatorError("Motion price changed. Review the reservation.", 409);
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<MotionJobDoc>("motion_jobs");
    const old = await jobs.findOne({ _id: key }, options); if (old) return same(old);
    const { view } = await currentMotionStudy(db, sid, studyId, input.study_sha256 as string, session);
    if (await jobs.countDocuments({ session_id: sid, study_id: studyId }, options) >= 20) throw new CreatorError("Motion study already has 20 requests", 409);
    await fenceViewSources(db, view, session);
    const ledger_ids = await reserveGenerationSpend(db, session, sid, "motion", quote.reservation, "MOTION_DAILY_CAP_USD", new Date(), "3");
    const job: MotionJobDoc = { _id: key, id, session_id: sid, study_id: studyId, study_sha256: input.study_sha256 as string,
      preparation_sha256: study.preparation_sha256, request_sha256: hash, ...quote, parameters: study.preparation.parameters,
      status: "scheduled", created_at: new Date(), ledger_ids, comparison };
    await jobs.insertOne(job, options); return { job: wireMotionJob(job) };
  });
}
export async function motionJobAction(sid: string, studyId: string, input: Record<string, unknown>) {
  if (input.action === "generate") return submitMotionJob(sid, studyId, input);
  const db = await access(sid, studyId);
  if (!isSafeId(input.id)) throw new CreatorError("Invalid motion identity", 400);
  const id = input.id;
  if (input.action === "review") {
    if (!isSafeId(input.review_id)) throw new CreatorError("Invalid review identity", 400);
    const reviewId = input.review_id, key = `${sid}:${reviewId}`, requestHash = viewHash(input);
    const same = (prior: MotionReviewDoc) => {
      if (prior.request_sha256 !== requestHash || prior.asset_id !== id || prior.study_id !== studyId) throw new CreatorError("Review identity already used", 409);
      return { review_id: prior.id, outcome: prior.outcome };
    };
    const prior = await db.collection<MotionReviewDoc>("motion_reviews").findOne({ _id: key, session_id: sid });
    if (prior) return same(prior);
    await motionVideoBytes(sid, studyId, id);
    return withDbTransaction(async (db, session) => {
      const options = { session }, reviews = db.collection<MotionReviewDoc>("motion_reviews");
      const old = await reviews.findOne({ _id: key }, options); if (old) return same(old);
      const asset = await db.collection<MotionAssetDoc>("motion_assets").findOne({ _id: `${sid}:${id}`, session_id: sid, study_id: studyId }, options);
      if (!asset?.comparison || asset.comparison.sha256 !== input.comparison_sha256 || viewHash(asset.comparison.plan) !== asset.comparison.sha256)
        throw new CreatorError("Clip has no matching pre-submission comparison contract", 409);
      if (await reviews.countDocuments({ session_id: sid, asset_id: id }, options) >= 20) throw new CreatorError("Clip already has 20 reviews", 409);
      const review = parseMotionReview(input.review, asset.comparison.plan), outcome = evaluateMotionReview(asset.comparison.plan, review, asset.media);
      const record: MotionReviewDoc = { _id: key, id: reviewId, session_id: sid, study_id: studyId, asset_id: id,
        request_sha256: requestHash, comparison_sha256: asset.comparison.sha256, video_sha256: asset.silent.sha256, review, outcome, created_at: new Date() };
      await reviews.insertOne(record, options); return { review_id: reviewId, outcome };
    });
  }
  if (input.action === "accept") {
    if (!isSafeId(input.review_id)) throw new CreatorError("A passing saved comparison review is required", 409);
    if (input.previous_id !== null && !isSafeId(input.previous_id)) throw new CreatorError("Invalid prior motion selection", 400);
    await motionVideoBytes(sid, studyId, id);
    return withDbTransaction(async (db, session) => {
      const options = { session }, selections = db.collection<{ _id: string; asset_id: string }>("motion_selections");
      const asset = await db.collection<MotionAssetDoc>("motion_assets").findOne({ _id: `${sid}:${id}`, session_id: sid, study_id: studyId }, options);
      if (!asset) throw new CreatorError("Motion asset missing", 404);
      const review = await db.collection<MotionReviewDoc>("motion_reviews").findOne({ _id: `${sid}:${input.review_id}`, session_id: sid, study_id: studyId, asset_id: id }, options);
      if (!asset.comparison || !review || review.comparison_sha256 !== asset.comparison.sha256 || review.video_sha256 !== asset.silent.sha256
        || viewHash(asset.comparison.plan) !== asset.comparison.sha256
        || evaluateMotionReview(asset.comparison.plan, parseMotionReview(review.review, asset.comparison.plan), asset.media).status !== "pass")
        throw new CreatorError("A passing saved comparison review is required", 409);
      const { view } = await currentMotionStudy(db, sid, studyId, asset.study_sha256, session);
      const prior = await selections.findOne({ _id: `${sid}:${studyId}` }, options);
      if (prior?.asset_id !== id && (prior?.asset_id ?? null) !== input.previous_id) throw new CreatorError("Motion selection changed", 409);
      await fenceViewSources(db, view, session);
      await selections.updateOne({ _id: `${sid}:${studyId}` }, { $set: { asset_id: id, review_id: input.review_id } }, { ...options, upsert: true });
      return { accepted_id: id };
    });
  }
  if (!["cancel", "retry_storage"].includes(String(input.action))) throw new CreatorError("Invalid motion action", 400);
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<MotionJobDoc>("motion_jobs");
    const job = await jobs.findOne({ _id: `${sid}:${id}`, session_id: sid, study_id: studyId }, options);
    if (!job) throw new CreatorError("Motion job missing", 404);
    if (input.action === "retry_storage") {
      if (job.status !== "storage_failed" || !job.request_id || !job.provider_result) throw new CreatorError("Motion storage is not retryable", 409);
      await jobs.updateOne({ _id: job._id }, { $set: { status: "storing", refresh_result: true, next_check: new Date() }, $unset: { error: "", work_token: "", work_until: "" } }, options);
      return { saved: true };
    }
    if (job.status === "cancelled") return { saved: true };
    if (["ready", "failed"].includes(job.status)) throw new CreatorError("Motion job already finished", 409);
    if (job.status === "scheduled") for (const ledgerId of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: ledgerId }, { $inc: { total: -job.reservation } }, options);
    await jobs.updateOne({ _id: job._id }, { $set: { status: "cancelled", error: job.status === "scheduled" ? "Cancelled before submission; reservation released." : "Result discarded; provider work may remain billable." } }, options);
    return { saved: true };
  });
}
export async function motionVideoBytes(sid: string, studyId: string, id: string) {
  const db = await access(sid, studyId);
  if (!isSafeId(id)) throw new CreatorError("Invalid motion video identity", 400);
  const asset = await db.collection<MotionAssetDoc>("motion_assets").findOne({ _id: `${sid}:${id}`, session_id: sid, study_id: studyId });
  if (!asset || asset.media.audio_streams !== 0) throw new CreatorError("Silent motion video unavailable", 404);
  const file = asset.silent, saved = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!saved || saved.bytes.length !== file.bytes || createHash("sha256").update(saved.bytes).digest("hex") !== file.sha256) throw new CreatorError("Motion video unavailable or corrupted", 503);
  return saved.bytes;
}
