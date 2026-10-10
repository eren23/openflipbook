import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyPilotMotionQuote(library, approved) {
  assert.ok(library.quote, library.reason || "Motion reference has no valid quote");
  assert.equal(library.quote.model, approved.model);
  assert.equal(library.quote.adapter, approved.adapter);
  assert.equal(library.quote.reservation, approved.reservation);
  assert.equal(library.comparison.plan.duration, 5);
  assert.deepEqual(library.comparison.plan.issues, []);
  assert.ok(library.comparison.plan.landmarks.length >= 3, "Target and two neighboring landmarks required");
  assert.ok(library.comparison.plan.frames.length >= 5, "Complete reference samples required");
}

export function motionReferenceReviewed(manifest, library) {
  const review = manifest.reviews?.motion_reference;
  return review?.approved === true && review.study_sha256 === library.study_sha256
    && review.comparison_sha256 === library.comparison.sha256 && typeof review.reviewed_at === "string"
    && Number.isFinite(Date.parse(review.reviewed_at));
}

// The first execution only saves local references. Root must inspect those exact
// bytes/criteria before the same phase can make its one bounded provider claim.
export async function runMotionPhase(ctx) {
  const { manifest, phaseState, get, post, id, persist, navigate, readScene, captureScreen,
    page, button, approvedUiWrites, prepareAction, log, atomicJson, directory, ready } = ctx;
  const settings = ctx.motionSettings ?? { viewport: { width: 1024, height: 800 }, distances: [55, 45],
    azimuth: 10, elevation: 55, duration: 5, artifact_prefix: "motion", label: "Pilot five-second approach / geometry reference" };
  const prefix = settings.artifact_prefix;
  assert.equal(manifest.phases.capture?.status, "complete", "Review and save the generated appearance first");
  const sid = manifest.world.session_id, pid = manifest.world.place_id;
  const viewsPath = `/api/world/${sid}/places/${pid}/views`;
  await page.setViewportSize(settings.viewport);
  await navigate("orbit");
  const scene = await readScene(), landmark = scene.definition.objects.find(object => object.label === "Copper Workshop");
  assert.ok(landmark?.structure?.floors.length === 2, "Saved named landmark missing");

  const uiWrite = async (name, path, body) => {
    const action = prepareAction(manifest, "motion", name, path, body, 0);
    assert.equal(action.status, "prepared", "Free capture acknowledgement requires reconciliation");
    action.status = "sent"; await persist(); return action;
  };
  const acknowledge = async (route, body, action) => {
    try {
      const response = await route.fetch({ postData: JSON.stringify(body) }), text = await response.text();
      action.http_status = response.status(); action.response_sha256 = hash(text); action.response = JSON.parse(text);
      action.status = response.ok() ? "acknowledged" : "rejected";
      await writeFile(join(directory, `motion-${action.name}-response.json`), text, { mode: 0o600 }); await persist();
      await route.fulfill({ response, body: text });
      assert.ok(response.ok(), `Free motion capture rejected ${response.status()}`);
      return action.response;
    } catch (error) { if (action.status === "sent") action.status = "unknown"; await persist(); throw error; }
  };

  if (!manifest.motion_view_id) {
    await button(`${landmark.label} building`).click();
    await button("Frame selected in 3D").click(); await ready();
    const path = page.getByRole("region", { name: "Camera path", exact: true });
    await path.getByRole("button", { name: "Camera path", exact: true }).click();
    await path.getByLabel("Camera path duration", { exact: true }).selectOption("5");
    const setPose = async (keyframe, distance) => {
      await path.getByRole("button", { name: `Camera keyframe ${keyframe}`, exact: true }).click();
      await path.getByLabel("Azimuth value", { exact: true }).fill(String(settings.azimuth));
      await path.getByLabel("Elevation value", { exact: true }).fill(String(settings.elevation));
      await path.getByLabel("Distance value", { exact: true }).fill(String(distance));
    };
    await setPose(1, settings.distances[0]); await setPose(2, settings.distances[1]);
    await path.getByRole("button", { name: "Rewind camera path", exact: true }).click();
    await path.getByRole("button", { name: "Check camera path", exact: true }).click();
    await expect(path.locator('[aria-label="Camera path validation"]').getByRole("status")).toContainText("Camera clearance passed");
    const panel = page.getByRole("region", { name: "Saved camera views", exact: true });
    await panel.getByLabel("View name", { exact: true }).fill(settings.label);
    const viewId = await id("motion-view");
    approvedUiWrites.set(viewsPath, async (route, original) => {
      assert.ok(original.capture.width <= 768 && original.capture.height <= 768);
      assert.equal(original.capture.path.duration, 5); assert.equal(original.capture.path.time, 0);
      const body = { ...original, id: viewId }, action = await uiWrite("save-view", viewsPath, body);
      await acknowledge(route, body, action); manifest.motion_view_id = viewId; await persist();
    });
    await panel.getByRole("button", { name: "Save camera view", exact: true }).click();
    await expect.poll(() => manifest.motion_view_id).toBe(viewId);
    await expect(panel.getByLabel("Saved camera view", { exact: true })).toHaveValue(viewId);
  }
  const viewId = manifest.motion_view_id;
  const panel = page.getByRole("region", { name: "Saved camera views", exact: true });
  await panel.getByLabel("Saved camera view", { exact: true }).selectOption(viewId);
  const savedViews = await get(viewsPath), view = savedViews.views.find(item => item.id === viewId);
  assert.ok(view && !view.historical && view.path?.duration === 5 && view.path?.time === 0);
  await atomicJson(join(directory, `${prefix}-saved-source-view.json`), view);

  if (!manifest.motion_study_id) {
    await panel.getByRole("button", { name: "Prepare motion references", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: /^Geometry reference/ })).toContainText("Clearance checked");
    const studyId = await id("motion-study"), path = `/api/world/${sid}/views/${viewId}/motion/studies`;
    approvedUiWrites.set(path, async (route, original) => {
      assert.equal(original.client_preflight.status, "clear");
      assert.ok(original.frames.length >= 5);
      for (const frame of original.frames) assert.ok(frame.capture.width <= 768 && frame.capture.height <= 768);
      const body = { ...original, id: studyId }, action = await uiWrite("save-study", path, body);
      await acknowledge(route, body, action); manifest.motion_study_id = studyId; await persist();
    });
    await panel.getByRole("button", { name: "Save motion study", exact: true }).click();
    await expect.poll(() => manifest.motion_study_id).toBe(studyId);
  }
  const studyId = manifest.motion_study_id, jobsPath = `/api/world/${sid}/motion-studies/${studyId}/jobs`;
  let library = await get(jobsPath);
  verifyPilotMotionQuote(library, phaseState.approval.models.motion);
  await atomicJson(join(directory, `${prefix}-frozen-comparison.json`), library);
  const references = [];
  for (let index = 0; index < library.comparison.plan.frames.length; index++) {
    const response = await page.request.get(`/api/world/${sid}/motion-studies/${studyId}/${index}/render`, { maxRedirects: 0 });
    assert.equal(response.status(), 200); const bytes = await response.body();
    const file = `${prefix}-reference-${index}.${hash(bytes)}.png`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    references.push({ index, file, sha256: hash(bytes), bytes: bytes.length });
  }
  if (ctx.verifyMotionReference) await ctx.verifyMotionReference({ view, library, references });
  await captureScreen(`${prefix}-source-and-criteria`);
  const reviewed = ctx.motionReferenceReviewed ? ctx.motionReferenceReviewed(manifest, library, references) : motionReferenceReviewed(manifest, library);
  if (!reviewed) {
    phaseState.awaiting_review = "motion_reference";
    phaseState.result = { study_id: studyId, view_id: viewId, study_sha256: library.study_sha256,
      comparison_sha256: library.comparison.sha256, submitted: false };
    await persist(); await log("motion_reference_ready_for_root_review", phaseState.result); return;
  }
  delete phaseState.awaiting_review;
  const jobId = await id("motion-clip");
  await post("clip", jobsPath, { action: "generate", id: jobId, confirmed: true, calibration_confirmed: true,
    study_sha256: library.study_sha256, comparison_sha256: library.comparison.sha256,
    reservation: library.quote.reservation }, library.quote.reservation);
  const end = Date.now() + 20 * 60_000; let previous;
  for (;;) {
    library = await get(jobsPath); const job = library.jobs.find(item => item.id === jobId);
    assert.ok(job, "Saved motion request missing");
    await atomicJson(join(directory, `${prefix}-saved-library.json`), library);
    if (previous !== job.status) { previous = job.status; await log("motion_job_status", { id: jobId, status: job.status }); }
    if (["failed", "cancelled", "submission_unknown", "storage_failed"].includes(job.status)) throw new Error(`Motion ${job.status}: preserve the original request; no reroll`);
    if (job.status === "ready") break;
    if (Date.now() > end) throw new Error("Motion still pending; preserve and reconcile the saved request");
    await page.waitForTimeout(5000);
  }
  assert.equal(library.assets.length, 1, "Pilot has one original motion submission");
  const asset = library.assets[0], response = await page.request.get(`/api/world/${sid}/motion-studies/${studyId}/videos/${asset.id}`, { maxRedirects: 0 });
  assert.equal(response.status(), 200); const bytes = await response.body(), videoFile = `${prefix}-${asset.id}.${hash(bytes)}.mp4`;
  await writeFile(join(directory, videoFile), bytes, { mode: 0o600 });
  phaseState.result = { study_id: studyId, view_id: viewId, asset, video_file: videoFile, video_sha256: hash(bytes),
    submitted: true, accepted: false, assessment: "Awaiting actual video/landmark comparison; source reference alone does not certify AI quality." };
  await persist(); await log("motion_clip_ready_for_comparison", { id: asset.id, file: videoFile });
  const { runMotionOutputReview } = await import("./quality-pilot-motion-output.mjs");
  await runMotionOutputReview(ctx);
}
