import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptPilotIllustrationOutput, illustrationOutputReviewed } from "./quality-pilot-illustration-output.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const asset = sha256 => ({ id: "illustration_one", sha256, content_type: "image/png", view_dependency: { view_id: "current-view" }, historical: false, accepted: false,
  keyframe: { version: 1, stage: "first", gate: "passed", passed: true, chosen: 0, candidates: [{ passed: true }], final_image: { version: 1, sha256, candidate_sha256: sha256, width: 768, height: 576, method: "candidate",
    invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 0, changed_protected_pixels: 0 } } } });
test("final output approval binds the exact image ID, bytes and recorded review time", () => {
  const image = asset(hash("image")), review = { approved: true, asset_id: image.id, sha256: image.sha256, reviewed_at: new Date().toISOString() };
  assert.equal(illustrationOutputReviewed({ reviews: { illustration_output: review } }, image), true);
  for (const patch of [{ approved: false }, { asset_id: "another" }, { sha256: "new-bytes" }, { reviewed_at: "invalid" }]) assert.equal(illustrationOutputReviewed({ reviews: { illustration_output: { ...review, ...patch } } }, image), false);
});
test("unreviewed image remains a draft and makes no product request", async () => {
  let calls = 0; const image = asset(hash("image")), phaseState = { result: { assets: [image] } };
  const result = await acceptPilotIllustrationOutput({ manifest: {}, phaseState, get: () => calls++, post: () => calls++, persist: async () => {}, log: async () => {} });
  assert.equal(result.accepted, false); assert.equal(calls, 0); assert.equal(phaseState.awaiting_review, "illustration_output");
});
test("explicit approval accepts only byte-verified current output and records content approval", async t => {
  const bytes = Buffer.from("unit fixture final PNG bytes"), image = asset(hash(bytes)), directory = await mkdtemp(join(tmpdir(), "illustration-output-")); t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, `${image.id}.${image.sha256}.png`), bytes);
  const review = { approved: true, asset_id: image.id, sha256: image.sha256, reviewed_at: new Date().toISOString() };
  const manifest = { world: { session_id: "session_pilot" }, reviews: { illustration_output: review } }, phaseState = { source: { view_id: "current-view" }, result: { assets: [image] } };
  const library = { assets: [image], historical: false, accepted_id: null }, writes = [];
  const context = { manifest, phaseState, directory, get: async () => library, post: async (name, path, body) => { writes.push({ name, path, body });
    image.accepted = true; image.keyframe.content_approval = { version: 1, method: "owner_review", sha256: image.sha256, reviewed_at: review.reviewed_at }; library.accepted_id = image.id; return { accepted_id: image.id }; }, persist: async () => {}, log: async () => {}, atomicJson: async () => {} };
  assert.equal((await acceptPilotIllustrationOutput(context)).accepted, true);
  assert.deepEqual(writes[0].body, { action: "accept", id: image.id, previous_id: null, reviewed_sha256: image.sha256 });
  await acceptPilotIllustrationOutput(context); assert.equal(writes.length, 1, "A reopened accepted output needs no new write");
  image.keyframe.final_image.invariants.opaque = false; image.accepted = false; library.accepted_id = null;
  await assert.rejects(acceptPilotIllustrationOutput(context), /verification/); assert.equal(writes.length, 1);
});
