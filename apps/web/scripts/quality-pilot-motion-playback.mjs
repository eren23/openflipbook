/** Real saved-video controls and decoder evidence. This helper makes no writes. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect as baseExpect } from "@playwright/test";
import { tsImport } from "tsx/esm/api";

const expect = baseExpect.configure({ timeout: 60_000 });
export function validateDecodedMotion(state, media) {
  assert.equal(state.error, null, "Saved video decoder failed");
  assert.ok(state.ready >= 2 && Number.isFinite(state.duration) && state.duration > 0, "Saved video did not decode");
  assert.equal(state.width, media.width); assert.equal(state.height, media.height);
  assert.ok(Math.abs(state.duration - media.duration) <= .1, "Browser duration differs from the saved media receipt");
}

export function selectPilotMotionPlayback(manifest) {
  const phase = manifest.phases.motion, retry = phase?.retry;
  const result = retry?.result?.submitted ? retry.result : phase?.result;
  if (!result?.submitted) return null;
  const viewId = result === retry?.result ? retry.view_id : manifest.motion_view_id;
  assert.ok(typeof viewId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(viewId), "Playback source view is missing");
  if (result === retry?.result) {
    assert.equal(result.study_id, retry.study_id, "Retry playback names another study");
    assert.notEqual(result.study_id, manifest.motion_study_id, "Retry must preserve the original study");
  }
  return { result, viewId, attempt: result === retry?.result ? "retry" : "original" };
}

export async function verifyPilotMotionPlayback({ page, manifest, navigate, get, directory, atomicJson, log }) {
  const selection = selectPilotMotionPlayback(manifest);
  if (!selection) return { status: "not_applicable", generation_submissions: 0 };
  const { result, viewId, attempt } = selection;
  const sid = manifest.world.session_id, path = `/api/world/${sid}/motion-studies/${result.study_id}/jobs`;
  const before = await get(path), asset = before.assets.find(item => item.id === result.asset.id);
  assert.ok(asset?.comparison, "Saved clip comparison is unavailable");
  await page.setViewportSize({ width: 1024, height: 820 }); await navigate("orbit");
  const views = page.getByRole("region", { name: "Saved camera views", exact: true });
  await views.getByLabel("Saved camera view", { exact: true }).selectOption(viewId);
  await views.getByLabel("Saved motion study", { exact: true }).selectOption(result.study_id);
  const motion = views.getByRole("region", { name: "AI camera motion", exact: true });
  await motion.getByLabel("Saved AI clip", { exact: true }).selectOption(asset.id);
  await motion.getByRole("button", { name: "Compare with geometry", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare camera motion", exact: true }), video = dialog.locator("video");
  const state = async () => video.evaluate(element => ({ ready: element.readyState, duration: element.duration,
    width: element.videoWidth, height: element.videoHeight, error: element.error?.message ?? null,
    time: element.currentTime, paused: element.paused, seeking: element.seeking,
    decoded_frames: element.getVideoPlaybackQuality?.().totalVideoFrames ?? null }));
  await expect.poll(async () => (await state()).ready).toBeGreaterThanOrEqual(2);
  const loaded = await state(); validateDecodedMotion(loaded, asset.media);
  await dialog.getByRole("button", { name: "Play full clip", exact: true }).click();
  await expect.poll(async () => (await state()).time).toBeGreaterThan(.5);
  await dialog.getByRole("button", { name: "Pause clip", exact: true }).click();
  const played = await state(); assert.ok(played.paused && played.time > .5 && !played.error);
  if (played.decoded_frames !== null) assert.ok(played.decoded_frames > 1, "Video clock advanced without decoded frames");
  const { motionSampleSeconds } = await tsImport("../lib/motion-comparison.ts", import.meta.url);
  const sampleIndex = asset.comparison.plan.frames.length - 1;
  const sample = motionSampleSeconds(asset.comparison.plan, asset.comparison.plan.frames[sampleIndex].seconds, asset.media.duration);
  await dialog.getByLabel("Comparison sample", { exact: true }).selectOption(String(sampleIndex));
  await expect.poll(async () => { const value = await state(); return value.paused && !value.seeking && Math.abs(value.time - sample) <= asset.comparison.plan.tolerances.seek_seconds; }).toBe(true);
  const sought = await state();
  await dialog.getByLabel("Comparison sample", { exact: true }).selectOption("0");
  await expect.poll(async () => { const value = await state(); return value.paused && !value.seeking && value.time <= asset.comparison.plan.tolerances.seek_seconds; }).toBe(true);
  await dialog.getByRole("button", { name: "Play full clip", exact: true }).click();
  await expect.poll(async () => (await state()).time).toBeGreaterThan(.5);
  await dialog.getByRole("button", { name: "Pause clip", exact: true }).click();
  const replayed = await state(); validateDecodedMotion(replayed, asset.media);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: join(directory, "replay-motion-controls.png") });
  await dialog.getByRole("button", { name: "Close camera comparison", exact: true }).click();
  const after = await get(path); assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.reviews, before.reviews); assert.equal(after.accepted_id, before.accepted_id);
  const report = { status: "passed", attempt, view_id: viewId, study_id: result.study_id, asset_id: asset.id,
    historical: asset.historical, accepted: before.accepted_id === asset.id,
    generation_submissions: 0, method: "App Play full clip / Pause clip / Comparison sample controls, twice played and sought",
    loaded, played, sought, replayed, checked_at: new Date().toISOString() };
  await atomicJson(join(directory, "replay-motion-playback.json"), report); await log("saved_motion_playback_verified", { asset_id: asset.id, accepted: report.accepted });
  return report;
}
