import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MOTION_RETRY_SETTINGS, motionRetryReferenceReviewed, runKnownMotionRetry,
  verifyMotionRetryEligibility, verifyMotionRetryReference } from "./quality-pilot-motion-retry.mjs";
import { prepareAction } from "./run-quality-pilot.mjs";

const hash = value => createHash("sha256").update(value).digest("hex"), jsonHash = value => hash(JSON.stringify(value));
const fixture = () => {
  const comparison = { plan: { version: "visible-bounds-human-v2", width: 704, height: 352, duration: 5,
    tolerances: { position: .03, relative_size: .2, direction_cosine: .7, motion_signal: .015, seek_seconds: .1, duration_ratio: .15, aspect_ratio: .01 },
    landmarks: ["workshop", "bakery", "bookshop"].map(id => ({ id, label: id })),
    frames: [0, 1.25, 2.5, 3.75, 5].map(seconds => ({ seconds, bounds: [[.1, .1, .2, .2], [.3, .3, .4, .4], [.5, .5, .6, .6]] })), issues: [] } };
  comparison.sha256 = jsonHash(comparison.plan);
  const outcome = { status: "fail", failures: ["Video aspect ratio differs from the reference"], incomplete: ["architecture"], measurements: [] };
  const review = { comparison_sha256: comparison.sha256, frames: [] }, reviewBytes = Buffer.from(JSON.stringify(review)), video = Buffer.from("actual-clip-bytes");
  const asset = { id: "motion-original-job", historical: false, media: { width: 1440, height: 704, duration: 5 }, comparison, duration_matches: true };
  const result = { study_id: "original-study", view_id: "original-view", asset, video_file: "original.mp4", video_sha256: hash(video), submitted: true, accepted: false,
    review: { id: "original-review", review_file: "observations.json", review_sha256: hash(reviewBytes), outcome } };
  const library = { study_sha256: "original-study-hash", comparison, jobs: [{ id: "original-job", status: "ready" }], assets: [asset], accepted_id: null,
    reviews: [{ id: "original-review", asset_id: asset.id, review, outcome }] };
  const view = { id: "original-view", historical: false, width: 704, height: 352, root_place_id: "root",
    sources: [{ place_id: "root", definition_sha256: "geometry-hash" }], path: { duration: 5, time: 0, target_id: "workshop", pivot: [20, 4, 20],
      keyframes: [55, 45].map(distance => ({ azimuth: 10, elevation: 55, distance })) } };
  const model = { model: "minimax/h3-max/camera-controls", adapter: "h3-source-relative-v2-measured", reservation: .4 };
  const manifest = { cap_usd: 5, world: { session_id: "sid", place_id: "root" }, motion_view_id: view.id, motion_study_id: result.study_id,
    phases: { motion: { reserved_usd: .8, approval: { max_reservation: .8, models: { motion: model } }, result }, other: { reserved_usd: 3.24 } },
    extension_phases: { west: { reserved_usd: .2 }, north: { reserved_usd: .2 } },
    request_ids: { "motion-clip": "original-job" }, actions: {}, reviews: { motion_output: { approved: true, accept: false,
      review_sha256: result.review.review_sha256, video_sha256: result.video_sha256 } }, retries: { motion: { approved: true, approved_by: "root", approved_at: "2026-10-04T12:00:00Z",
      failed_job_id: "original-job", failed_asset_id: asset.id, failed_video_sha256: result.video_sha256, failed_study_id: result.study_id,
      failed_study_sha256: library.study_sha256, failed_comparison_sha256: comparison.sha256, failed_review_id: result.review.id,
      failed_review_sha256: result.review.review_sha256, source_definition_sha256: "geometry-hash", settings: structuredClone(MOTION_RETRY_SETTINGS) } } };
  const ack = (name, body, response, reservation = 0) => {
    const action = prepareAction(manifest, "motion", name, `/api/${name}`, body, reservation);
    action.status = "acknowledged"; action.response = response; action.response_sha256 = jsonHash(response); return action;
  };
  ack("clip", { action: "generate", id: "original-job", study_sha256: library.study_sha256, comparison_sha256: comparison.sha256, reservation: .4 }, { id: "original-job" }, .4);
  ack("output-review", { action: "review", id: asset.id, review_id: result.review.id, comparison_sha256: comparison.sha256, review }, { outcome });
  ack("save-view", { id: view.id }, { id: view.id }); ack("save-study", { id: result.study_id }, { id: result.study_id });
  return { manifest, library, view, video, reviewBytes };
};
const retryReference = fixture => {
  const view = structuredClone(fixture.view); view.id = "retry-view"; view.width = 640; view.height = 384;
  view.path.keyframes = [40, 36].map(distance => ({ azimuth: 10, elevation: 55, distance }));
  const library = structuredClone(fixture.library); library.study_sha256 = "retry-study-hash";
  library.comparison.plan.width = 640; library.comparison.plan.height = 384; library.comparison.sha256 = jsonHash(library.comparison.plan);
  const references = library.comparison.plan.frames.map((_, index) => ({ index, file: `motion-retry-reference-${index}.png`, sha256: hash(`new-PNG-${index}`), bytes: 25 }));
  return { view, library, references };
};

test("one retry binds the ready unaccepted job, saved failed review and original .8 envelope", () => {
  const f = fixture(); assert.equal(verifyMotionRetryEligibility(f).result, f.manifest.phases.motion.result);
  const changes = [f => { delete f.manifest.retries; }, f => { f.manifest.retries.motion.approved_by = "agent"; },
    f => { f.library.jobs[0].status = "submission_unknown"; }, f => { f.library.accepted_id = f.library.assets[0].id; },
    f => { f.manifest.phases.motion.result.review.outcome.status = "pass"; }, f => { f.library.reviews = []; },
    f => { f.manifest.retries.motion.failed_video_sha256 = "other"; }, f => { f.manifest.retries.motion.settings.distances[1] = 30; },
    f => { f.manifest.actions["motion:clip"].status = "unknown"; }, f => { f.manifest.actions["motion:output-review"].status = "prepared"; },
    f => { f.manifest.actions.other = { phase: "edit", status: "sent", reserved_usd: 0 }; },
    f => { f.manifest.actions["motion:third-clip"] = { phase: "motion", status: "prepared", reserved_usd: .4 }; },
    f => { f.manifest.extension_phases.north.reserved_usd = 1; }, f => { f.manifest.phases.motion.reserved_usd = 1.2; }];
  for (const change of changes) { const value = fixture(); change(value); assert.throws(() => verifyMotionRetryEligibility(value)); }
});

test("retry keeps geometry, landmark identities and product tolerances while recording actual source size", () => {
  const f = fixture(), r = retryReference(f);
  verifyMotionRetryReference({ originalView: f.view, originalLibrary: f.library, ...r });
  const changes = [r => { r.view.sources[0].definition_sha256 = "different"; }, r => { r.view.path.keyframes[1].distance = 35; },
    r => { r.library.comparison.plan.tolerances.aspect_ratio = .03; }, r => { r.library.comparison.plan.width = 800; r.view.width = 800; },
    r => { r.library.comparison.plan.landmarks.reverse(); }, r => { r.library.comparison.plan.frames.pop(); r.references.pop(); },
    r => { r.library.comparison.plan.issues.push("target occluded"); }];
  for (const change of changes) { const value = retryReference(f); change(value); value.library.comparison.sha256 = jsonHash(value.library.comparison.plan);
    assert.throws(() => verifyMotionRetryReference({ originalView: f.view, originalLibrary: f.library, ...value })); }
});

test("second paid gate binds every exact reviewed PNG, study and comparison", () => {
  const r = retryReference(fixture()), approval = { approved: true, reviewed_at: "2026-10-04T12:00:00Z", study_sha256: r.library.study_sha256,
    comparison_sha256: r.library.comparison.sha256, reference_sha256: r.references.map(item => item.sha256) };
  assert.equal(motionRetryReferenceReviewed(approval, r.library, r.references), true);
  for (const patch of [{ approved: false }, { reviewed_at: "unknown" }, { study_sha256: "other" }, { comparison_sha256: "other" },
    { reference_sha256: approval.reference_sha256.slice(1) }, { reference_sha256: [...approval.reference_sha256].reverse() }]) {
    assert.equal(motionRetryReferenceReviewed({ ...approval, ...patch }, r.library, r.references), false);
  }
});

async function writeOriginal(f, directory) {
  const json = (name, value) => writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(directory, f.manifest.phases.motion.result.video_file), f.video);
  await writeFile(join(directory, f.manifest.phases.motion.result.review.review_file), f.reviewBytes);
  await json("motion-saved-source-view.json", f.view); await json("motion-frozen-comparison.json", f.library);
  await json("motion-saved-library.json", f.library); await json("motion-output-evaluation.json", { outcome: f.library.reviews[0].outcome });
  for (const name of ["clip", "output-review", "save-view", "save-study"]) await json(`motion-${name}-response.json`, f.manifest.actions[`motion:${name}`].response);
  for (const index of [0, 1, 2, 3, 4]) { const bytes = Buffer.from(`original-PNG-${index}`); await writeFile(join(directory, `motion-reference-${index}.${hash(bytes)}.png`), bytes); }
}

test("scoped retry preserves original receipts, refuses unreviewed payment and reuses the one fixed second ID", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-motion-retry-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), r = retryReference(f), originalResult = structuredClone(f.manifest.phases.motion.result); await writeOriginal(f, directory);
  const calls = [], ctx = { manifest: f.manifest, phaseState: f.manifest.phases.motion, directory,
    get: async () => f.library, persist: async () => {}, id: async name => f.manifest.request_ids[name] ??= `${name}-fixed`,
    prepareAction, atomicJson: async (path, value) => writeFile(path, JSON.stringify(value)),
    post: async (name, path, body, reservation) => {
      const action = prepareAction(f.manifest, "motion", name, path, body, reservation);
      if (action.status !== "acknowledged") { calls.push({ name, body, reservation }); action.status = "acknowledged"; action.response = { id: body.id }; }
      return action.response;
    } };
  const runMotionPhase = async scoped => {
    assert.deepEqual(scoped.motionSettings.viewport, { width: 960, height: 832 });
    scoped.manifest.motion_view_id = "retry-view"; scoped.manifest.motion_study_id = "retry-study";
    await scoped.verifyMotionReference(r);
    const id = await scoped.id("motion-clip"), body = { id, action: "generate" };
    if (!scoped.motionReferenceReviewed(scoped.manifest, r.library, r.references)) {
      await assert.rejects(scoped.post("clip", "/api/retry/jobs", body, .4), /review every exact retry/);
      scoped.phaseState.awaiting_review = "motion_reference"; scoped.phaseState.result = { submitted: false, study_id: "retry-study", view_id: "retry-view" };
    } else {
      delete scoped.phaseState.awaiting_review; await scoped.post("clip", "/api/retry/jobs", body, .4);
      scoped.phaseState.result = { submitted: true, study_id: "retry-study", view_id: "retry-view", asset: { id: "retry-asset" } };
    }
    await scoped.atomicJson(join(directory, "motion-output-evaluation.json"), { retry: true }); await scoped.persist();
  };
  await runKnownMotionRetry(ctx, { runMotionPhase }); assert.equal(calls.length, 0);
  assert.equal(ctx.phaseState.awaiting_review, "motion_retry_reference"); assert.deepEqual(ctx.phaseState.retry.source_dimensions, { width: 640, height: 384 });
  f.manifest.reviews.motion_retry_reference = { approved: true, reviewed_at: "2026-10-04T12:00:00Z", study_sha256: r.library.study_sha256,
    comparison_sha256: r.library.comparison.sha256, reference_sha256: r.references.map(item => item.sha256) };
  await runKnownMotionRetry(ctx, { runMotionPhase }); await runKnownMotionRetry(ctx, { runMotionPhase });
  assert.equal(calls.length, 1); assert.equal(calls[0].name, "retry-clip"); assert.equal(calls[0].reservation, .4);
  assert.equal(calls[0].body.id, f.manifest.request_ids["motion-retry-clip"]); assert.deepEqual(ctx.phaseState.result, originalResult);
  assert.equal(f.manifest.motion_study_id, originalResult.study_id); assert.equal(f.manifest.motion_view_id, originalResult.view_id);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "motion-output-evaluation.json"), "utf8")), { outcome: f.library.reviews[0].outcome });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "motion-retry-output-evaluation.json"), "utf8")), { retry: true });
  for (const receipt of ctx.phaseState.retry.original.files) assert.equal(hash(await readFile(join(directory, receipt.archive_file))), receipt.sha256);
  await writeFile(join(directory, "observations.json"), "changed-review"); await assert.rejects(runKnownMotionRetry(ctx, { runMotionPhase }), /observation bytes changed/);
  assert.equal(calls.length, 1);
});
