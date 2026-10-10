import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePilotMotionOutput, runMotionOutputReview } from "./quality-pilot-motion-output.mjs";
import { selectPilotMotionPlayback, validateDecodedMotion } from "./quality-pilot-motion-playback.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const plan = { version: "visible-bounds-human-v2", provenance: "client_geometry_masks_human_video_bounds", width: 768, height: 576, duration: 5,
    tolerances: { position: .03, relative_size: .2, direction_cosine: .7, motion_signal: .015, seek_seconds: .1, duration_ratio: .15, aspect_ratio: .01 },
    landmarks: [{ id: "workshop", label: "Workshop" }, { id: "bakery", label: "Bakery" }, { id: "books", label: "Bookshop" }],
    frames: Array.from({ length: 5 }, (_, i) => ({ seconds: i * 1.25, bounds: [[.2, .2, .4, .4], [.5, .2, .6, .35], [.3, .5, .5, .65]].map(box => [box[0] + i * .01, box[1], box[2] + i * .01, box[3]]) })), issues: [] };
  const comparison = { plan, sha256: hash(JSON.stringify(plan)) }, media = { width: 768, height: 576, duration: 5.4, audio_streams: 0 };
  const asset = { id: "clip-one", comparison, media, historical: false }, clipBytes = Buffer.from("unit fixture silent video bytes");
  const result = { asset, submitted: true, study_id: "study-one", video_file: "clip.mp4", video_sha256: hash(clipBytes) };
  const review = { observations: plan.frames.flatMap((frame, index) => plan.landmarks.map((landmark, i) => ({ frame: index, object_id: landmark.id,
    observed_seconds: frame.seconds * media.duration / plan.duration, bounds: frame.bounds[i] }))), visual: { architecture: "pass", occlusion_order: "pass", continuous_motion: "pass" }, notes: "Unit fixture; these are not pilot measurements." };
  const reviewBytes = Buffer.from(JSON.stringify(review)), approval = { approved: true, asset_id: asset.id, video_sha256: result.video_sha256,
    comparison_sha256: comparison.sha256, review_file: "review.json", review_sha256: hash(reviewBytes), reviewed_at: new Date().toISOString() };
  return { result, review, clipBytes, reviewBytes, approval, library: { assets: [asset], reviews: [], accepted_id: null } };
}
test("uses the actual product evaluator, including ratio-scaled video sample times", async () => {
  const data = fixture(); assert.equal((await evaluatePilotMotionOutput(data)).outcome.status, "pass");
  data.review.observations[14].bounds = [.6, .5, .8, .65]; data.reviewBytes = Buffer.from(JSON.stringify(data.review)); data.approval.review_sha256 = hash(data.reviewBytes);
  assert.equal((await evaluatePilotMotionOutput(data)).outcome.status, "fail");
  data.review.observations = []; data.reviewBytes = Buffer.from(JSON.stringify(data.review)); data.approval.review_sha256 = hash(data.reviewBytes);
  assert.equal((await evaluatePilotMotionOutput(data)).outcome.status, "incomplete");
});
test("refuses unbound observations, changed local clip and corrupted comparison metadata", async () => {
  for (const mutate of [data => data.clipBytes = Buffer.from("other"), data => data.reviewBytes = Buffer.from("{}"), data => data.approval.comparison_sha256 = "other",
    data => data.approval.asset_id = "other", data => data.approval.reviewed_at = "invalid", data => data.library.assets[0].comparison.plan.width++]) {
    const data = fixture(); mutate(data); await assert.rejects(evaluatePilotMotionOutput(data));
  }
});
test("missing root review preserves a ready clip and sends no product requests", async () => {
  const data = fixture(), state = { result: data.result }; let calls = 0;
  const saved = await runMotionOutputReview({ manifest: {}, phaseState: state, post: () => calls++, get: () => calls++, persist: async () => {}, log: async () => {} });
  assert.equal(saved.awaiting_review, true); assert.equal(state.result.video_sha256, data.result.video_sha256); assert.equal(calls, 0);
});
test("records a failed observed clip without accepting it even when approval requests acceptance", async t => {
  const data = fixture(); data.review.visual.architecture = "fail"; data.reviewBytes = Buffer.from(JSON.stringify(data.review));
  data.approval.review_sha256 = hash(data.reviewBytes); data.approval.accept = true;
  const directory = await mkdtemp(join(tmpdir(), "motion-output-")); t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, "clip.mp4"), data.clipBytes); await writeFile(join(directory, "review.json"), data.reviewBytes);
  const expected = await evaluatePilotMotionOutput(data), writes = [], state = { result: data.result };
  const manifest = { world: { session_id: "session_pilot" }, actions: {}, reviews: { motion_output: data.approval } };
  const saved = await runMotionOutputReview({ manifest, phaseState: state, directory, get: async () => data.library,
    post: async (name, path, body) => { writes.push({ name, path, body }); data.library.reviews.push({ id: body.review_id, asset_id: body.id, review: body.review, outcome: expected.outcome }); return { review_id: body.review_id, outcome: expected.outcome }; },
    id: async () => "fixed-review", persist: async () => {}, log: async () => {}, atomicJson: async () => {} });
  assert.equal(saved.outcome.status, "fail"); assert.equal(saved.accepted, false); assert.equal(writes.length, 1); assert.equal(writes[0].body.action, "review");
  assert.equal(state.result.video_sha256, data.result.video_sha256); assert.equal(state.awaiting_review, "motion_output_fail");
});
test("browser playback proof refuses decoder errors and mismatched video receipts", () => {
  const media = { width: 768, height: 576, duration: 5.4 }, valid = { ready: 2, duration: 5.4, width: 768, height: 576, error: null };
  validateDecodedMotion(valid, media);
  for (const patch of [{ ready: 1 }, { error: "codec unavailable" }, { width: 1024 }, { duration: NaN }, { duration: 6 }]) assert.throws(() => validateDecodedMotion({ ...valid, ...patch }, media));
});
test("actual playback selects a ready retry while retaining original study/view identity and falls back to the original", () => {
  const original = { submitted: true, study_id: "original-study", asset: { id: "original-clip" }, accepted: false };
  const retry = { submitted: true, study_id: "retry-study", asset: { id: "retry-clip" }, accepted: false };
  const manifest = { motion_study_id: "original-study", motion_view_id: "original-view", phases: { motion: { result: original,
    retry: { study_id: "retry-study", view_id: "retry-view", result: retry } } } }, before = structuredClone(manifest);
  assert.deepEqual(selectPilotMotionPlayback(manifest), { result: retry, viewId: "retry-view", attempt: "retry" });
  assert.deepEqual(manifest, before);
  retry.submitted = false; assert.deepEqual(selectPilotMotionPlayback(manifest), { result: original, viewId: "original-view", attempt: "original" });
  retry.submitted = true; retry.study_id = "original-study"; assert.throws(() => selectPilotMotionPlayback(manifest), /another study/);
  assert.equal(selectPilotMotionPlayback({ phases: {} }), null);
});
