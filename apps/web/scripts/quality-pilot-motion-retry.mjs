/** One explicitly approved second clip; ordinary product routes, no provider calls here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonHash = value => hash(JSON.stringify(value));
export const MOTION_RETRY_SETTINGS = Object.freeze({ viewport: { width: 960, height: 832 }, distances: [40, 36],
  azimuth: 10, elevation: 55, duration: 5 });
const localFile = value => {
  assert.ok(typeof value === "string" && value.length && basename(value) === value && ![".", ".."].includes(value), "Motion receipt must name a local file");
  return value;
};

export function verifyMotionRetryEligibility({ manifest, library, view }) {
  const approval = manifest.retries?.motion, state = manifest.phases.motion, result = state?.result;
  assert.equal(approval?.approved, true, "A retry requires explicit root approval of the known failure");
  assert.equal(approval.approved_by, "root"); assert.ok(Number.isFinite(Date.parse(approval.approved_at)));
  assert.deepEqual(approval.settings, MOTION_RETRY_SETTINGS, "Retry camera configuration changed");
  assert.equal(result?.submitted, true); assert.equal(result.accepted, false);
  assert.equal(result.review?.outcome?.status, "fail", "Save the actual failed product review before retrying");
  assert.equal(result.study_id, manifest.motion_study_id); assert.equal(result.view_id, manifest.motion_view_id);
  const original = manifest.actions["motion:clip"], jobId = manifest.request_ids["motion-clip"];
  assert.equal(original?.status, "acknowledged", "Original paid submission requires an acknowledged fixed ID");
  assert.equal(original.body.id, jobId); assert.equal(original.body.action, "generate");
  assert.equal(original.reserved_usd, .4); assert.equal(original.body.reservation, .4);
  assert.equal(original.body.study_sha256, library.study_sha256); assert.equal(original.body.comparison_sha256, library.comparison.sha256);
  assert.equal(library.jobs.length, 1); assert.equal(library.jobs[0].id, jobId); assert.equal(library.jobs[0].status, "ready");
  assert.equal(library.assets.length, 1); assert.equal(library.assets[0].id, result.asset.id);
  assert.deepEqual(library.assets[0], result.asset); assert.equal(library.accepted_id, null, "Original failed output must remain unselected");
  assert.equal(jsonHash(library.comparison.plan), library.comparison.sha256);
  assert.deepEqual(result.asset.comparison, library.comparison);
  const savedReview = library.reviews.find(item => item.id === result.review.id && item.asset_id === result.asset.id);
  assert.ok(savedReview, "Known failed review must reopen from the product library");
  assert.deepEqual(savedReview.outcome, result.review.outcome);
  const reviewApproval = manifest.reviews?.motion_output;
  assert.equal(reviewApproval?.approved, true); assert.equal(reviewApproval.accept, false);
  assert.equal(reviewApproval.review_sha256, result.review.review_sha256);
  assert.equal(reviewApproval.video_sha256, result.video_sha256);
  const reviewAction = manifest.actions["motion:output-review"];
  assert.equal(reviewAction?.status, "acknowledged", "Failed comparison review needs a saved product acknowledgement");
  assert.equal(reviewAction.body.id, result.asset.id); assert.equal(reviewAction.body.review_id, result.review.id);
  assert.equal(reviewAction.body.comparison_sha256, library.comparison.sha256);
  assert.deepEqual(reviewAction.body.review, savedReview.review);
  assert.deepEqual(reviewAction.response.outcome, savedReview.outcome);
  const bindings = { failed_job_id: jobId, failed_asset_id: result.asset.id, failed_video_sha256: result.video_sha256,
    failed_study_id: result.study_id, failed_study_sha256: library.study_sha256, failed_comparison_sha256: library.comparison.sha256,
    failed_review_id: result.review.id, failed_review_sha256: result.review.review_sha256 };
  for (const [key, value] of Object.entries(bindings)) assert.equal(approval[key], value, `Retry approval changed ${key}`);
  assert.equal(view.id, result.view_id); assert.equal(view.root_place_id, manifest.world.place_id);
  assert.equal(view.sources.length, 1); assert.equal(view.sources[0].definition_sha256, approval.source_definition_sha256);
  assert.equal(state.reserved_usd, .8); assert.equal(state.approval.models.motion.reservation, .4);
  const held = [...Object.values(manifest.phases), ...Object.values(manifest.extension_phases ?? {})]
    .reduce((sum, phase) => sum + Math.round(phase.reserved_usd * 1e6), 0);
  assert.ok(Number.isFinite(held) && held <= Math.round(manifest.cap_usd * 1e6), "Combined pilot reservation cap exceeded");
  let paid = 0;
  for (const [key, action] of Object.entries(manifest.actions)) {
    assert.ok(["prepared", "acknowledged"].includes(action.status), `Reconcile ${key} before retry; no unknown submission retries`);
    if (action.phase === "motion" && action.reserved_usd > 0) {
      assert.ok(["motion:clip", "motion:retry-clip"].includes(key), "No third motion submission is authorized");
      assert.equal(action.reserved_usd, .4); paid += action.reserved_usd;
    }
  }
  assert.ok(paid <= .8, "Motion retry exceeds the original two-clip envelope");
  if (state.retry) {
    assert.equal(state.retry.approval_sha256, jsonHash(approval), "Retry approval changed after preparation");
    assert.equal(state.retry.original.result_sha256, jsonHash(result), "First attempt receipt changed");
  }
  return { result, approval };
}

export function verifyMotionRetryReference({ originalView, originalLibrary, view, library, references }) {
  assert.deepEqual(view.sources, originalView.sources, "Retry source geometry changed");
  assert.equal(view.root_place_id, originalView.root_place_id); assert.equal(view.historical, false);
  assert.equal(view.path.duration, 5); assert.equal(view.path.time, 0);
  assert.equal(view.path.target_id, originalView.path.target_id); assert.deepEqual(view.path.pivot, originalView.path.pivot);
  assert.deepEqual(view.path.keyframes.map(frame => ({ azimuth: frame.azimuth, elevation: frame.elevation, distance: frame.distance })),
    [40, 36].map(distance => ({ azimuth: 10, elevation: 55, distance })), "Retry must use the approved gentler path");
  const plan = library.comparison.plan, oldPlan = originalLibrary.comparison.plan;
  assert.equal(jsonHash(plan), library.comparison.sha256); assert.equal(plan.version, oldPlan.version);
  assert.deepEqual(plan.tolerances, oldPlan.tolerances, "Retry cannot relax frozen product tolerances");
  assert.deepEqual(plan.landmarks, oldPlan.landmarks); assert.ok(plan.landmarks.length >= 3);
  assert.deepEqual(plan.issues, []); assert.equal(plan.duration, 5); assert.ok(plan.frames.length >= 5);
  assert.deepEqual(plan.frames.map(frame => frame.seconds), oldPlan.frames.map(frame => frame.seconds));
  assert.equal(plan.width, view.width); assert.equal(plan.height, view.height);
  for (const value of [plan.width, plan.height]) assert.ok(Number.isInteger(value) && value > 0 && value <= 768, "Actual retry capture exceeds source bounds");
  assert.equal(references.length, plan.frames.length);
  for (const [index, reference] of references.entries()) {
    assert.equal(reference.index, index); assert.match(reference.sha256, /^[a-f0-9]{64}$/); assert.ok(reference.bytes > 0);
  }
}

export function motionRetryReferenceReviewed(approval, library, references) {
  return approval?.approved === true && Number.isFinite(Date.parse(approval.reviewed_at))
    && approval.study_sha256 === library.study_sha256 && approval.comparison_sha256 === library.comparison.sha256
    && jsonHash(approval.reference_sha256) === jsonHash(references.map(item => item.sha256));
}

async function preserveOriginal(directory, result, originalLibrary) {
  const referenceFiles = (await readdir(directory)).filter(file => /^motion-reference-\d+\.[a-f0-9]{64}\.png$/.test(file));
  assert.equal(referenceFiles.length, originalLibrary.comparison.plan.frames.length, "Preserve every original source frame");
  const names = new Set([result.video_file, result.review.review_file, "motion-saved-source-view.json", "motion-frozen-comparison.json", "motion-saved-library.json",
    "motion-output-evaluation.json", "motion-save-view-response.json", "motion-save-study-response.json", "motion-clip-response.json", "motion-output-review-response.json",
    ...referenceFiles]);
  const files = [];
  for (const name of names) {
    const bytes = await readFile(join(directory, localFile(name)));
    if (name === result.video_file) assert.equal(hash(bytes), result.video_sha256, "Original video bytes changed");
    if (name === result.review.review_file) assert.equal(hash(bytes), result.review.review_sha256, "Original observation bytes changed");
    if (referenceFiles.includes(name)) assert.equal(name.split(".")[1], hash(bytes), "Original source PNG bytes changed");
    const archiveFile = `motion-retry-preserved-original-${name}`, path = join(directory, archiveFile);
    try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; assert.equal(hash(await readFile(path)), hash(bytes), "Archived first attempt changed"); }
    files.push({ file: name, sha256: hash(bytes), archive_file: archiveFile });
  }
  const bytes = Buffer.from(`${JSON.stringify(originalLibrary, null, 2)}\n`), libraryFile = "motion-retry-preserved-original-library.json", path = join(directory, libraryFile);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; assert.deepEqual(JSON.parse(await readFile(path, "utf8")), originalLibrary, "Original reviewed library changed"); }
  return { result: structuredClone(result), result_sha256: jsonHash(result), library_file: libraryFile, library_sha256: hash(bytes), files };
}

// Isolate all retry IDs, actions, source files and result fields. The ordinary
// phase post callback keeps its original ack cache and .8 budget unchanged.
export async function runKnownMotionRetry(ctx, dependencies = {}) {
  const { manifest, phaseState, directory } = ctx, originalResult = phaseState.result;
  const originalLibrary = await ctx.get(`/api/world/${manifest.world.session_id}/motion-studies/${originalResult.study_id}/jobs`);
  const originalView = JSON.parse(await readFile(join(directory, "motion-saved-source-view.json"), "utf8"));
  const { approval } = verifyMotionRetryEligibility({ manifest, library: originalLibrary, view: originalView });
  for (const name of ["save-view", "save-study", "clip", "output-review"]) {
    const action = manifest.actions[`motion:${name}`], bytes = await readFile(join(directory, `motion-${name}-response.json`));
    assert.equal(action?.status, "acknowledged"); assert.equal(hash(bytes), action.response_sha256, "First attempt acknowledgement bytes changed");
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), action.response);
  }
  const original = await preserveOriginal(directory, originalResult, originalLibrary);
  phaseState.retry ??= { approval_sha256: jsonHash(approval), original };
  const retry = phaseState.retry;
  assert.deepEqual(retry.original, original, "Preserved first attempt receipts changed");
  retry.approval = phaseState.approval; retry.reserved_usd = phaseState.reserved_usd;
  const scoped = { ...manifest, motion_view_id: retry.view_id, motion_study_id: retry.study_id,
    reviews: { motion_reference: manifest.reviews?.motion_retry_reference, motion_output: manifest.reviews?.motion_retry_output }, actions: {} };
  const syncActions = () => {
    scoped.actions = Object.fromEntries(Object.entries(manifest.actions).filter(([key]) => key.startsWith("motion:retry-"))
      .map(([key, action]) => [key.replace("motion:retry-", "motion:"), action]));
  };
  syncActions();
  let frozenReference;
  const persist = async () => {
    assert.equal(jsonHash(phaseState.result), original.result_sha256, "Retry attempted to replace the first clip receipt");
    retry.view_id = scoped.motion_view_id; retry.study_id = scoped.motion_study_id;
    if (retry.awaiting_review) phaseState.awaiting_review = retry.awaiting_review.replace("motion_", "motion_retry_");
    else delete phaseState.awaiting_review;
    await ctx.persist();
  };
  const runMotionPhase = dependencies.runMotionPhase ?? (await import("./quality-pilot-motion.mjs")).runMotionPhase;
  await runMotionPhase({ ...ctx, manifest: scoped, phaseState: retry, persist,
    motionSettings: { ...MOTION_RETRY_SETTINGS, artifact_prefix: "motion-retry", label: "Pilot bounded retry / gentle approach" },
    id: name => ctx.id(`motion-retry-${name.replace(/^motion-/, "")}`),
    prepareAction: (_manifest, phase, name, path, body, reservation) => {
      const action = ctx.prepareAction(manifest, phase, `retry-${name}`, path, body, reservation); syncActions(); return action;
    },
    post: async (name, path, body, reservation = 0) => {
      assert.ok(["clip", "output-review", "accept-output"].includes(name), "Unapproved retry write");
      if (name === "clip") {
        assert.ok(frozenReference && motionRetryReferenceReviewed(manifest.reviews?.motion_retry_reference,
          frozenReference.library, frozenReference.references), "Root must review every exact retry source PNG before the second paid claim");
        assert.equal(reservation, .4); assert.equal(body.id, manifest.request_ids["motion-retry-clip"]);
      }
      const result = await ctx.post(`retry-${name}`, path, body, reservation); syncActions(); return result;
    },
    atomicJson: (path, value) => ctx.atomicJson(path.endsWith("/motion-output-evaluation.json") ? join(directory, "motion-retry-output-evaluation.json") : path, value),
    verifyMotionReference: async receipt => {
      verifyMotionRetryReference({ originalView, originalLibrary, ...receipt });
      frozenReference = receipt;
      if (retry.reference_receipts) assert.deepEqual(retry.reference_receipts, receipt.references, "Frozen retry PNG bytes changed");
      retry.reference_receipts = receipt.references; retry.source_dimensions = { width: receipt.view.width, height: receipt.view.height };
      await persist();
    },
    motionReferenceReviewed: (_manifest, library, references) => motionRetryReferenceReviewed(manifest.reviews?.motion_retry_reference, library, references)
  });
  await persist();
}
