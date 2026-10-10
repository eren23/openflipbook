/** Free review of root-supplied observations. Never generates or invents measurements. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tsImport } from "tsx/esm/api";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
let evaluator;
const evaluation = () => evaluator ??= tsImport("../lib/motion-comparison.ts", import.meta.url);
const localFile = file => {
  assert.ok(typeof file === "string" && file.length && ![".", ".."].includes(file) && basename(file) === file, "Review evidence must name a local file");
  return file;
};

export async function evaluatePilotMotionOutput({ library, result, approval, reviewBytes, clipBytes }) {
  assert.equal(approval.approved, true, "The actual output needs a recorded root review");
  assert.ok(Number.isFinite(Date.parse(approval.reviewed_at)), "Review time is required");
  assert.equal(approval.asset_id, result.asset.id, "Review names another output");
  assert.equal(hash(clipBytes), result.video_sha256, "Local clip bytes changed");
  assert.equal(approval.video_sha256, result.video_sha256, "Review names different clip bytes");
  assert.equal(hash(reviewBytes), approval.review_sha256, "Actual observation JSON changed after root review");
  assert.ok(reviewBytes.length <= 64 * 1024, "Review JSON exceeds the product request bound");
  const asset = library.assets.find(item => item.id === result.asset.id);
  assert.ok(asset?.comparison, "The output has no frozen pre-submission comparison");
  const comparison = asset.comparison;
  assert.equal(hash(JSON.stringify(comparison.plan)), comparison.sha256, "Frozen comparison is corrupted");
  assert.equal(approval.comparison_sha256, comparison.sha256, "Review names another comparison");
  assert.deepEqual(asset.media, result.asset.media, "Saved media metadata changed");
  const { parseMotionReview, evaluateMotionReview } = await evaluation();
  const review = parseMotionReview(JSON.parse(reviewBytes.toString("utf8")), comparison.plan);
  return { asset, comparison, review, outcome: evaluateMotionReview(comparison.plan, review, asset.media) };
}

// Inject the existing driver's durable free post/id callbacks. Caller wires this
// after the clip receipt is saved; absence of review remains a review gate.
export async function runMotionOutputReview(ctx) {
  const { manifest, phaseState, get, post, id, persist, log, atomicJson, directory } = ctx;
  const result = phaseState.result;
  assert.equal(result?.submitted, true, "Keep the original ready clip receipt before reviewing");
  const approval = manifest.reviews?.motion_output;
  if (approval?.approved !== true) {
    phaseState.awaiting_review = "motion_output";
    result.assessment = "Awaiting actual output measurements; reference geometry does not certify the generated clip.";
    await persist(); await log("motion_output_awaiting_review", { asset_id: result.asset.id, video_sha256: result.video_sha256 });
    return { awaiting_review: true, accepted: false };
  }
  const clipBytes = await readFile(join(directory, localFile(result.video_file)));
  const reviewBytes = await readFile(join(directory, localFile(approval.review_file)));
  assert.ok(safeId(manifest.world.session_id) && safeId(result.study_id) && safeId(result.asset.id), "Saved motion identity is invalid");
  const jobsPath = `/api/world/${manifest.world.session_id}/motion-studies/${result.study_id}/jobs`;
  let library = await get(jobsPath);
  const checked = await evaluatePilotMotionOutput({ library, result, approval, reviewBytes, clipBytes });
  await atomicJson(join(directory, "motion-output-evaluation.json"), { version: 1, asset_id: result.asset.id,
    video_sha256: result.video_sha256, comparison_sha256: checked.comparison.sha256,
    review_file: approval.review_file, review_sha256: approval.review_sha256,
    provenance: "human_measurements_not_independent_attestation", review: checked.review, outcome: checked.outcome });
  const reviewId = await id("motion-output-review");
  const body = { action: "review", id: result.asset.id, review_id: reviewId,
    comparison_sha256: checked.comparison.sha256, review: checked.review };
  assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= 64 * 1024, "Complete review action exceeds the product request bound");
  const saved = await post("output-review", jobsPath, body);
  assert.equal(saved.review_id, reviewId); assert.deepEqual(saved.outcome, checked.outcome, "Saved evaluation differs from the product evaluator");
  library = await get(jobsPath);
  const reopened = library.reviews.find(item => item.id === reviewId && item.asset_id === result.asset.id);
  assert.ok(reopened, "Saved comparison review failed to reopen");
  assert.deepEqual(reopened.review, checked.review); assert.deepEqual(reopened.outcome, checked.outcome);
  result.review = { id: reviewId, review_file: approval.review_file, review_sha256: approval.review_sha256, outcome: checked.outcome };
  result.accepted = library.accepted_id === result.asset.id;
  if (checked.outcome.status !== "pass") {
    assert.equal(result.accepted, false, "A failed or incomplete output must remain unaccepted");
    phaseState.awaiting_review = `motion_output_${checked.outcome.status}`;
    result.assessment = `Recorded root comparison ${checked.outcome.status}; preserve output and measurements, with no automatic replacement.`;
    await persist(); await log("motion_output_review_failed", { asset_id: result.asset.id, status: checked.outcome.status,
      failures: checked.outcome.failures, incomplete: checked.outcome.incomplete });
    return { awaiting_review: true, accepted: false, outcome: checked.outcome };
  }
  delete phaseState.awaiting_review;
  if (approval.accept === true && !result.accepted) {
    assert.equal(checked.asset.historical, false, "Historical clips can replay but cannot become the current selection");
    // Reuse the original previous selection after uncertain acknowledgement.
    const oldBody = manifest.actions["motion:accept-output"]?.body;
    if (oldBody) assert.ok(oldBody.action === "accept" && oldBody.id === result.asset.id && oldBody.review_id === reviewId,
      "Saved output acceptance identity changed");
    const accepted = await post("accept-output", jobsPath, oldBody ?? { action: "accept", id: result.asset.id,
      previous_id: library.accepted_id ?? null, review_id: reviewId });
    assert.equal(accepted.accepted_id, result.asset.id);
    library = await get(jobsPath); assert.equal(library.accepted_id, result.asset.id); result.accepted = true;
  }
  result.assessment = `Recorded root comparison passed / ${result.accepted ? "accepted" : "unselected"}; replay does not require acceptance.`;
  await persist(); await log("motion_output_review_saved", { asset_id: result.asset.id, review_id: reviewId, accepted: result.accepted });
  return { awaiting_review: false, accepted: result.accepted, outcome: checked.outcome };
}
