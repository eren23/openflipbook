/** Free current-geometry refresh before a separately reviewed illustration claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function immutableViewHash(view) {
  const immutable = { ...view }; delete immutable.historical; delete immutable.accepted_illustration_id;
  return hash(JSON.stringify(immutable));
}
export function illustrationSourceReviewed(manifest, source) {
  const review = manifest.reviews?.illustration_source;
  return review?.approved === true && review.view_id === source.view_id && review.view_sha256 === source.view_sha256
    && review.render_sha256 === source.render_sha256 && Number.isFinite(Date.parse(review.reviewed_at));
}
export function assertRefreshedCamera(original, capture) {
  assert.equal(capture.width, original.width); assert.equal(capture.height, original.height);
  assert.equal(capture.mode, original.mode); assert.equal(capture.floor_id, original.floor_id);
  assert.deepEqual(capture.camera, original.camera, "Refresh must preserve the exact reviewed camera");
  assert.equal(capture.path, undefined); assert.ok(capture.width <= 768 && capture.height <= 768);
}

export async function captureCurrentIllustrationSource(ctx) {
  const { manifest, phaseState, get, id, persist, navigate, page, approvedUiWrites, prepareAction, log, atomicJson, directory, captureScreen } = ctx;
  assert.equal(manifest.phases.capture?.status, "complete", "Capture the reviewed appearance first");
  const sid = manifest.world.session_id, pid = manifest.world.place_id, viewsPath = `/api/world/${sid}/places/${pid}/views`;
  let viewId = manifest.illustration_view_id ?? manifest.capture_view_id;
  let view = (await get(viewsPath)).views.find(item => item.id === viewId); assert.ok(view, "Saved source camera is missing");
  await page.setViewportSize({ width: 1024, height: 820 }); await navigate("orbit");
  const panel = page.getByRole("region", { name: "Saved camera views", exact: true });
  await panel.getByLabel("Saved camera view", { exact: true }).selectOption(viewId);
  if (view.historical) {
    assert.ok(!manifest.illustration_view_id && !phaseState.source, "Reviewed refreshed source changed; reconcile it before another request");
    const oldView = view, refreshedId = await id("illustration-refreshed-view");
    approvedUiWrites.set(viewsPath, async (route, original) => {
      assert.equal(original.refreshed_from, oldView.id); assertRefreshedCamera(oldView, original.capture);
      const body = { ...original, id: refreshedId }, action = prepareAction(manifest, "illustration", "refresh-source", viewsPath, body);
      assert.equal(action.status, "prepared", "Source refresh acknowledgement needs reconciliation");
      action.status = "sent"; await persist();
      try {
        const response = await route.fetch({ postData: JSON.stringify(body) }), text = await response.text();
        action.http_status = response.status(); action.response_sha256 = hash(text); action.response = JSON.parse(text);
        action.status = response.ok() ? "acknowledged" : "rejected";
        await writeFile(join(directory, "illustration-refresh-source-response.json"), text, { mode: 0o600 });
        if (response.ok()) manifest.illustration_view_id = refreshedId;
        await persist(); await route.fulfill({ response, body: text }); assert.ok(response.ok(), `Source refresh rejected ${response.status()}`);
      } catch (error) { if (action.status === "sent") action.status = "unknown"; await persist(); throw error; }
    });
    await panel.getByRole("button", { name: "Refresh saved view geometry", exact: true }).click();
    await expect.poll(() => manifest.illustration_view_id).toBe(refreshedId);
    await expect(panel.getByLabel("Saved camera view", { exact: true })).toHaveValue(refreshedId);
    viewId = refreshedId; view = (await get(viewsPath)).views.find(item => item.id === viewId);
    assert.ok(view && !view.historical && view.refreshed_from === oldView.id);
    assertRefreshedCamera(oldView, view);
  }
  assert.ok(!view.historical, "Illustration source must bind to current saved geometry");
  const passes = [];
  for (const pass of ["render", "depth", "normals", "objects"]) {
    const response = await page.request.get(`/api/world/${sid}/views/${viewId}/${pass}`, { maxRedirects: 0 }); assert.equal(response.status(), 200);
    const bytes = await response.body(), sha256 = hash(bytes), file = `illustration-source-${viewId}-${pass}.${sha256}.png`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 }); passes.push({ pass, sha256, bytes: bytes.length, file });
  }
  const source = { view_id: viewId, view_sha256: immutableViewHash(view), render_sha256: passes[0].sha256, passes, sources: view.sources };
  if (phaseState.source) assert.deepEqual(source, phaseState.source, "Illustration source receipt changed after review");
  phaseState.source = source; await atomicJson(join(directory, "illustration-current-source.json"), { source, view }); await persist();
  const latest = (await get(viewsPath)).views.find(item => item.id === viewId);
  assert.ok(latest && !latest.historical && immutableViewHash(latest) === source.view_sha256, "Geometry changed while refreshing the source");
  await captureScreen("illustration-current-source"); await log("current_illustration_source", { view_id: viewId, view_sha256: source.view_sha256, render_sha256: source.render_sha256 });
  return source;
}
