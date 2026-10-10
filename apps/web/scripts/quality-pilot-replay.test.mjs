import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySavedPilotMedia, readPilotReplayNetwork, assertPilotReplayNetworkUnchanged } from "./quality-pilot-replay.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "quality-replay-")); t.after(() => rm(directory, { recursive: true }));
  const manifest = { world: { session_id: "session_pilot" }, capture_view_id: "saved-view", phases: {} }, owned = new Map(), calls = [];
  const image = async (prefix, path, bytes) => { const file = `${prefix}${hash(bytes)}.png`; await writeFile(join(directory, file), bytes); owned.set(path, bytes); return file; };
  for (const pass of ["render", "depth", "normals", "objects"]) await image(`capture-saved-view-${pass}.`, `/api/world/session_pilot/views/saved-view/${pass}`, Buffer.from(pass));
  const page = { request: { get: async (path, options) => { calls.push({ path, options }); return { status: () => owned.has(path) ? 200 : 404, body: async () => owned.get(path), json: async () => owned.get(path) }; } } };
  return { directory, manifest, owned, calls, page, image, atomicJson: async () => {} };
}
test("replay reopens every saved pass, candidate, reference and video without product writes", async t => {
  const ctx = await fixture(t), illustration = Buffer.from("final illustration"), clip = Buffer.from("silent original clip");
  ctx.manifest.phases.illustration = { result: { assets: [{ id: "illustration_one", sha256: hash(illustration), content_type: "image/png" }] } };
  await writeFile(join(ctx.directory, `illustration_one.${hash(illustration)}.png`), illustration); ctx.owned.set("/api/world/session_pilot/illustrations/illustration_one", illustration);
  ctx.manifest.motion_study_id = "study-one";
  const plan = { frames: Array.from({ length: 5 }, () => ({})) }, comparison = { plan, sha256: hash(JSON.stringify(plan)) };
  const asset = { id: "clip-one", comparison, media: { width: 64, height: 48, duration: 5, audio_streams: 0 } };
  ctx.owned.set("/api/world/session_pilot/motion-studies/study-one/jobs", { comparison, jobs: [{ status: "ready", asset_id: asset.id }], assets: [asset], reviews: [], accepted_id: null });
  for (let index = 0; index < 5; index++) await ctx.image(`motion-reference-${index}.`, `/api/world/session_pilot/motion-studies/study-one/${index}/render`, Buffer.from(`frame ${index}`));
  const file = `motion-clip.${hash(clip)}.mp4`; await writeFile(join(ctx.directory, file), clip); ctx.owned.set("/api/world/session_pilot/motion-studies/study-one/videos/clip-one", clip);
  ctx.manifest.phases.motion = { result: { submitted: true, study_id: "study-one", asset, video_file: file, video_sha256: hash(clip) } };
  const receipts = await verifySavedPilotMedia(ctx); assert.equal(receipts.length, 11); assert.equal(ctx.calls.length, 12);
  assert.ok(ctx.calls.every(call => call.path.startsWith("/api/world/session_pilot/") && call.options.maxRedirects === 0));
});
test("replay refuses changed owned bytes and changed local evidence against original hashes", async t => {
  const ctx = await fixture(t), path = "/api/world/session_pilot/views/saved-view/render", original = ctx.owned.get(path);
  ctx.owned.set(path, Buffer.from("replacement")); await assert.rejects(verifySavedPilotMedia(ctx), /original receipt/);
  ctx.owned.set(path, original); await writeFile(join(ctx.directory, `capture-saved-view-render.${hash(original)}.png`), Buffer.from("changed local"));
  ctx.calls.length = 0; await assert.rejects(verifySavedPilotMedia(ctx), /evidence bytes changed/); assert.equal(ctx.calls.length, 0);
});
test("replay refuses ambiguous rerolled receipts and unexpected local video paths", async t => {
  const ctx = await fixture(t); await writeFile(join(ctx.directory, `capture-saved-view-render.${hash("second render")}.png`), "second render");
  await assert.rejects(verifySavedPilotMedia(ctx), /One original/); assert.equal(ctx.calls.length, 0);
  const other = await fixture(t); other.manifest.phases.motion = { result: { submitted: true, study_id: "study", asset: { id: "clip" }, video_file: "../private.json", video_sha256: hash("anything") } };
  await assert.rejects(verifySavedPilotMedia(other), /local evidence file/);
});

function networkFixture() {
  const chunks = [
    ["root", 0, 0, 3], ["annex", 40, 4, 2], ["west", -16, 0, 2], ["north", 0, -40, 1],
  ].map(([place_id, x, z, count]) => ({ x, z, scene: { id: `scene-${place_id}`, session_id: "session_pilot", place_id,
    revision: 2, source_node_id: null, updated_at: "2026-10-04T10:00:00.000Z", definition: { version: 2,
      objects: Array.from({ length: count }, (_, i) => ({ id: `${place_id}-${i}`, kind: "building", label: `${place_id} ${i}`, x: i + 1 })) } } }));
  const network = { chunks, connections: ["annex", "west", "north"].map(place_id => ({ id: `link-${place_id}`,
    a: { place_id: "root" }, b: { place_id }, width: 3 })) };
  const owned = new Map([["/api/world/session_pilot/places/root/connections", { network }]]), calls = [];
  for (const chunk of chunks) {
    const base = `/api/world/session_pilot/places/${chunk.scene.place_id}`;
    owned.set(`${base}/scene`, { scene: structuredClone(chunk.scene) });
    owned.set(`${base}/build`, { jobs: [{ id: `job-${chunk.scene.place_id}`, status: "ready" }] });
  }
  // Existing text edits leave an internal planning fence in network chunks.
  chunks[0].scene.text_edit_fence = 3;
  const manifest = { world: { session_id: "session_pilot", place_id: "root" }, extensions: { growth: {} },
    extension_phases: Object.fromEntries(["west", "north"].map(area => { const scene = chunks.find(c => c.scene.place_id === area).scene;
      return [`growth_${area}`, { status: "complete", boundary: { place_id: area }, result: { revision: 2, definition_sha256: hash(JSON.stringify(scene.definition)) } }]; })) };
  const get = async path => { calls.push(path); assert.ok(owned.has(path)); return structuredClone(owned.get(path)); };
  return { manifest, network, owned, calls, get };
}
test("replay checks every saved building, revision, transform, connection and owned build library", async () => {
  const ctx = networkFixture(), before = await readPilotReplayNetwork(ctx), after = await readPilotReplayNetwork(ctx);
  const report = assertPilotReplayNetworkUnchanged(before, after);
  assert.equal(report.buildings, 8); assert.equal(report.connections, 3); assert.equal(report.places.length, 4);
  assert.equal(ctx.calls.length, 18); assert.equal(new Set(ctx.calls).size, 9); assert.equal(report.generation_submissions, 0);
  for (const alter of [value => value.network.chunks[2].x++, value => value.network.connections[0].width++,
    value => value.places[3].scene.revision++, value => value.places[2].scene.definition.objects[0].x++,
    value => value.places[1].jobs.push({ id: "new-job" })]) {
    const changed = structuredClone(after); alter(changed); assert.throws(() => assertPilotReplayNetworkUnchanged(before, changed));
  }
});
test("replay refuses missing/unreviewed growth or a mismatched canonical saved scene", async () => {
  const ctx = networkFixture(); ctx.owned.get("/api/world/session_pilot/places/annex/scene").scene.revision++;
  await assert.rejects(readPilotReplayNetwork(ctx), error => error instanceof AggregateError
    && error.errors.some(item => /Owner scene differs/.test(item.message)));
  assert.ok(ctx.calls.includes("/api/world/session_pilot/places/north/build"), "Independent reads must still be inspected");
  const other = networkFixture(); other.manifest.extension_phases.growth_north.status = "awaiting_review";
  await assert.rejects(readPilotReplayNetwork(other), /Complete the reviewed growth/);
  const missing = networkFixture(); missing.network.chunks.pop();
  await assert.rejects(readPilotReplayNetwork(missing), /growth place is absent/);
});
test("replay also supports an original saved world before adjoining areas exist", async () => {
  const ctx = networkFixture(); delete ctx.manifest.extensions; ctx.owned.get("/api/world/session_pilot/places/root/connections").network = null;
  const saved = await readPilotReplayNetwork(ctx); assert.equal(saved.places.length, 1); assert.equal(saved.connections, 0); assert.equal(saved.buildings, 3);
});

async function motionRetryFixture(t) {
  const ctx = await fixture(t);
  const saved = async (file, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    await writeFile(join(ctx.directory, file), bytes); return { file, sha256: hash(bytes), bytes: bytes.length }; };
  const make = async (name, reviewed) => {
    const study_id = `study-${name}`, asset_id = `clip-${name}`, plan = { frames: Array.from({ length: 5 }, (_, seconds) => ({ seconds })) };
    const comparison = { plan, sha256: hash(JSON.stringify(plan)) }, asset = { id: asset_id, comparison,
      media: { width: 64, height: 48, duration: 5, audio_streams: 0 }, historical: false }, references = [];
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.from(`${name} reference ${i}`), prefix = name === "original" ? `motion-reference-${i}.` : `motion-retry-reference-${i}.`;
      const file = await ctx.image(prefix, `/api/world/session_pilot/motion-studies/${study_id}/${i}/render`, bytes);
      references.push({ index: i, file, sha256: hash(bytes), bytes: bytes.length });
    }
    const clip = Buffer.from(`${name} silent video`), video = await saved(`${name}-clip.mp4`, clip);
    ctx.owned.set(`/api/world/session_pilot/motion-studies/${study_id}/videos/${asset_id}`, clip);
    const library = { comparison, jobs: [{ id: `job-${name}`, status: "ready", asset_id }], assets: [asset], reviews: [], accepted_id: null };
    const result = { submitted: true, study_id, view_id: `view-${name}`, asset, video_file: video.file, video_sha256: video.sha256, accepted: false };
    if (reviewed) {
      const review = { observations: [], visual: { architecture: "unreviewed", occlusion_order: "pass", continuous_motion: "pass" }, notes: "Synthetic failed review fixture" };
      const raw = await saved(`${name}-observations.json`, review), outcome = { status: "fail", failures: ["Size drift"], incomplete: [] };
      result.review = { id: `review-${name}`, review_file: raw.file, review_sha256: raw.sha256, outcome };
      library.reviews.push({ id: result.review.id, asset_id, review, outcome });
    }
    ctx.owned.set(`/api/world/session_pilot/motion-studies/${study_id}/jobs`, library);
    return { result, library, references };
  };
  const original = await make("original", true), retry = await make("retry", false);
  ctx.manifest.motion_study_id = original.result.study_id; ctx.manifest.motion_view_id = original.result.view_id;
  const library = await saved("motion-retry-preserved-original-library.json", original.library), files = [];
  for (const file of [original.result.video_file, original.result.review.review_file, original.references[0].file]) {
    const bytes = await readFile(join(ctx.directory, file)), archive_file = `motion-retry-preserved-original-${file}`;
    await writeFile(join(ctx.directory, archive_file), bytes); files.push({ file, archive_file, sha256: hash(bytes) });
  }
  ctx.manifest.phases.motion = { result: structuredClone(original.result), retry: { view_id: retry.result.view_id,
    study_id: retry.result.study_id, result: retry.result, reference_receipts: retry.references,
    original: { result: structuredClone(original.result), result_sha256: hash(JSON.stringify(original.result)), files,
      library_file: library.file, library_sha256: library.sha256 } } };
  return { ...ctx, original, retry };
}
test("replay retains the failed original review and hashes both distinct motion studies/videos without acceptance", async t => {
  const ctx = await motionRetryFixture(t), before = structuredClone(ctx.manifest), receipts = await verifySavedPilotMedia(ctx);
  assert.equal(receipts.filter(receipt => receipt.kind === "motion-reference").length, 5);
  assert.equal(receipts.filter(receipt => receipt.kind === "motion-retry-reference").length, 5);
  assert.equal(receipts.filter(receipt => ["motion-video", "motion-retry-video"].includes(receipt.kind)).length, 2);
  assert.equal(receipts.filter(receipt => receipt.kind === "motion-review").length, 1);
  assert.deepEqual(ctx.manifest, before); assert.equal(ctx.original.library.accepted_id, null);
  assert.ok(ctx.calls.every(call => call.options.maxRedirects === 0));
});
test("replay refuses original result/archive/review corruption, lost ready jobs and unexpected acceptance", async t => {
  for (const alter of [ctx => { ctx.manifest.phases.motion.result.assessment = "replacement"; },
    async ctx => { await writeFile(join(ctx.directory, ctx.manifest.phases.motion.retry.original.files[0].archive_file), "changed archive"); },
    ctx => { ctx.original.library.reviews[0].outcome = { status: "pass" }; },
    ctx => { ctx.original.library.jobs[0].status = "running"; },
    ctx => { ctx.original.library.accepted_id = ctx.original.result.asset.id; },
    ctx => { ctx.retry.references[0].bytes++; },
    ctx => { ctx.retry.references.reverse(); },
    ctx => { ctx.manifest.phases.motion.retry.study_id = ctx.manifest.motion_study_id; }]) {
    const ctx = await motionRetryFixture(t); await alter(ctx); await assert.rejects(verifySavedPilotMedia(ctx));
  }
});
test("a retry prepared for review still reopens the original failed output and its own saved references", async t => {
  const ctx = await motionRetryFixture(t); delete ctx.manifest.phases.motion.retry.result;
  const receipts = await verifySavedPilotMedia(ctx);
  assert.equal(receipts.filter(receipt => receipt.kind === "motion-retry-reference").length, 5);
  assert.equal(receipts.filter(receipt => receipt.kind === "motion-retry-video").length, 0);
});
