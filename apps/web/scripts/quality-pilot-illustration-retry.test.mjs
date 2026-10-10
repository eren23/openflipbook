import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAction } from "./run-quality-pilot.mjs";
import { runKnownIllustrationRetry, verifyKnownIllustrationRetry } from "./quality-pilot-illustration-retry.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const quote = { model: "fal-ai/qwen-image-edit-2511", reservation: .1, parameters: { num_images: 2 } }, originalId = "original-job";
  const bytes = Buffer.from("unit fixture failed cropped candidate"), asset = { id: `illustration_${originalId}`, sha256: hash(bytes), content_type: "image/png",
    historical: false, accepted: false, keyframe: { gate: "failed", passed: false }, view_dependency: { view_id: "current-view" } };
  const source = { view_id: "current-view", view_sha256: "view-hash", render_sha256: "render-hash" }, path = "/api/world/session_pilot/views/current-view/illustrations";
  const phaseState = { reserved_usd: .3, source, result: { source, assets: [asset], submitted: true, accepted: false } };
  const approval = { approved: true, failed_job_id: originalId, failed_asset_id: asset.id, failed_sha256: asset.sha256,
    reason: "Observed camera crop and added roof geometry", approved_at: new Date().toISOString() };
  const manifest = { phases: { illustration: phaseState }, request_ids: {}, actions: { "illustration:keyframe": { status: "acknowledged", path, reserved_usd: .1,
    body: { action: "generate_keyframe", id: originalId, ...structuredClone(quote) }, response: { job: { id: originalId } } } }, retries: { illustration: approval },
    reviews: { illustration_source: { approved: true, ...source, reviewed_at: new Date().toISOString() } } };
  const library = { jobs: [{ id: originalId, status: "ready" }], assets: [asset], historical: false };
  return { manifest, phaseState, library, originalId, quote, path, bytes };
}
test("retry requires exact approved known failure and acknowledged ready original", () => {
  assert.ok(verifyKnownIllustrationRetry(fixture()));
  for (const change of [ctx => ctx.manifest.actions["illustration:keyframe"].status = "unknown", ctx => ctx.library.jobs[0].status = "running",
    ctx => ctx.library.assets[0].keyframe.gate = "passed", ctx => ctx.manifest.retries.illustration.failed_sha256 = "other",
    ctx => ctx.manifest.retries.illustration.failed_job_id = "other", ctx => ctx.manifest.retries.illustration.reason = "",
    ctx => ctx.manifest.retries.illustration.approved_at = "invalid", ctx => ctx.library.assets[0].accepted = true,
    ctx => ctx.quote.parameters.num_images = 1, ctx => ctx.library.jobs.push({ id: "unfamiliar", status: "ready" })]) {
    const ctx = fixture(); change(ctx); assert.throws(() => verifyKnownIllustrationRetry(ctx));
  }
});
test("no retry approval permits no fallback or new request", async () => {
  const ctx = fixture(); delete ctx.manifest.retries; let calls = 0;
  assert.equal(await runKnownIllustrationRetry({ ...ctx, post: () => calls++, id: () => calls++ }), null); assert.equal(calls, 0);
});
test("uncertain or second retry actions refuse before a request", () => {
  for (const status of ["unknown", "sent", "rejected"]) {
    const ctx = fixture(); ctx.manifest.actions["illustration:keyframe-retry"] = { status }; assert.throws(() => verifyKnownIllustrationRetry(ctx), /reconciled/);
  }
  const ctx = fixture(); ctx.manifest.actions["illustration:keyframe-retry2"] = { status: "prepared" }; assert.throws(() => verifyKnownIllustrationRetry(ctx), /one explicit/);
  const unknown = fixture(); unknown.manifest.actions["illustration:refresh-source"] = { status: "unknown" }; assert.throws(() => verifyKnownIllustrationRetry(unknown), /unreconciled/);
});
test("freezes originals before one paid action and reuses its UUID without resubmitting original", async t => {
  const ctx = fixture(), directory = await mkdtemp(join(tmpdir(), "illustration-retry-")); t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, `${ctx.library.assets[0].id}.${ctx.library.assets[0].sha256}.png`), ctx.bytes);
  let actualRequests = 0; const names = [];
  Object.assign(ctx, { directory, persist: async () => {}, log: async () => {}, id: async name => { ctx.manifest.request_ids[name] ??= "fixed-retry"; return ctx.manifest.request_ids[name]; },
    post: async (name, path, body, reservation) => { names.push(name);
      assert.ok(ctx.phaseState.original_receipts.length === 2); await readFile(join(directory, "illustration-original-result.json"));
      const action = prepareAction(ctx.manifest, "illustration", name, path, body, reservation);
      if (action.status === "acknowledged") return action.response;
      actualRequests++; action.status = "acknowledged"; action.response = { job: { id: body.id } }; ctx.library.jobs.push({ id: body.id, status: "ready" }); return action.response;
    } });
  const first = await runKnownIllustrationRetry(ctx), frozen = await readFile(join(directory, "illustration-original-result.json"));
  assert.equal(first.job.id, "fixed-retry"); assert.equal(actualRequests, 1); assert.deepEqual(names, ["keyframe-retry"]);
  ctx.phaseState.result = { assets: [{ id: "illustration_fixed-retry" }], submitted: true, accepted: false };
  await runKnownIllustrationRetry(ctx); assert.equal(actualRequests, 1); assert.deepEqual(await readFile(join(directory, "illustration-original-result.json")), frozen);
  await writeFile(join(directory, "illustration-original-result.json"), "tampered"); await assert.rejects(runKnownIllustrationRetry(ctx), /frozen/); assert.equal(actualRequests, 1);
});
test("changed source, approval and local failed bytes cannot spend the retry", async t => {
  const ctx = fixture(), directory = await mkdtemp(join(tmpdir(), "illustration-retry-bad-")); t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, `${ctx.library.assets[0].id}.${ctx.library.assets[0].sha256}.png`), "changed bytes"); let calls = 0;
  await assert.rejects(runKnownIllustrationRetry({ ...ctx, directory, post: () => calls++ }), /failed bytes changed/); assert.equal(calls, 0);
  ctx.phaseState.source.render_sha256 = "other"; assert.throws(() => verifyKnownIllustrationRetry(ctx), /reviewed current source/);
  const other = fixture(); other.phaseState.retry = { approval: { ...other.manifest.retries.illustration, reason: "another approval" } }; assert.throws(() => verifyKnownIllustrationRetry(other), /approval changed/);
});
