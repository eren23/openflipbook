import assert from "node:assert/strict";
import test from "node:test";
import { assertRefreshedCamera, captureCurrentIllustrationSource, illustrationSourceReviewed, immutableViewHash } from "./quality-pilot-capture-source.mjs";

const view = () => ({ id: "view-original", width: 734, height: 690, mode: "orbit", floor_id: null, historical: false,
  camera: { projection: "perspective", world_matrix: [1, 2, 3], projection_matrix: [4, 5, 6], near: .1, far: 400 },
  sources: [{ place_id: "place-root", scene_id: "scene", revision: 2, definition_sha256: "original" }] });

test("source review authorizes exactly one current saved capture and its render bytes", () => {
  const source = { view_id: "refreshed-view", view_sha256: "metadata-hash", render_sha256: "render-hash" };
  const review = { approved: true, ...source, reviewed_at: new Date().toISOString() }, manifest = { reviews: { illustration_source: review } };
  assert.equal(illustrationSourceReviewed(manifest, source), true);
  for (const patch of [{ view_id: "old-view" }, { view_sha256: "new-geometry" }, { render_sha256: "changed-bytes" }, { reviewed_at: "invalid" }, { approved: false }]) {
    assert.equal(illustrationSourceReviewed({ reviews: { illustration_source: { ...review, ...patch } } }, source), false);
  }
});
test("refresh preserves the exact original camera, floor and size while new scene revisions remain visible", () => {
  const original = view(), refreshed = { ...structuredClone(original), id: "refreshed", sources: [{ ...original.sources[0], revision: 4, definition_sha256: "current" }] };
  assertRefreshedCamera(original, refreshed); assert.notEqual(immutableViewHash(original), immutableViewHash(refreshed));
  for (const mutate of [value => value.camera.world_matrix[0]++, value => value.width++, value => value.floor_id = "upper", value => value.path = { duration: 5 }]) {
    const changed = structuredClone(refreshed); mutate(changed); assert.throws(() => assertRefreshedCamera(original, changed));
  }
  assert.equal(immutableViewHash(original), immutableViewHash({ ...original, historical: true, accepted_illustration_id: "reviewed-candidate" }));
});
test("source preparation stops before any request when complete applied capture is missing", async () => {
  let calls = 0;
  await assert.rejects(captureCurrentIllustrationSource({ manifest: { phases: {} }, get: () => calls++, post: () => calls++ }), /Capture the reviewed/);
  assert.equal(calls, 0);
});
