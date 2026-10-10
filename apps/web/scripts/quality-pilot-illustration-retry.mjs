/** One expressly approved retry of a ready, byte-identified failed camera gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { illustrationSourceReviewed } from "./quality-pilot-capture-source.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const ILLUSTRATION_RETRY_PROMPT = "Texture-paint the supplied image only with restrained hand-painted limestone, teal ceramic and wood surface detail. Keep the exact full input image framing, camera, field of view and every object silhouette and proportion. No zoom, enlargement, reframing, perspective changes or cropping. Keep every roof ridge, roof edge, door and window exactly where it is. Do not add dormers, timber framing, beams, openings, extra roofs, architectural details, furniture, objects, text or decorations. Preserve the surrounding buildings and all clear gaps, occlusion and image margins. Apply subtle surface paint only; do not redesign or move any geometry.";

export function verifyKnownIllustrationRetry({ manifest, phaseState, library, originalId, quote }) {
  const approval = manifest.retries?.illustration;
  if (approval?.approved !== true) return null;
  const original = manifest.actions["illustration:keyframe"], retry = manifest.actions["illustration:keyframe-retry"];
  assert.equal(original?.status, "acknowledged", "Only an acknowledged original request can authorize a known-failure retry");
  assert.equal(original.body.id, originalId); assert.equal(original.response.job.id, originalId);
  assert.equal(original.body.action, "generate_keyframe");
  assert.equal(original.reserved_usd, quote.reservation);
  assert.equal(original.body.model, quote.model); assert.deepEqual(original.body.parameters, quote.parameters);
  assert.equal(original.body.reservation, quote.reservation); assert.equal(quote.reservation, .1);
  assert.ok(illustrationSourceReviewed(manifest, phaseState.source), "Retry requires the same exact reviewed current source");
  assert.equal(library.historical, false);
  const job = library.jobs.find(item => item.id === originalId), asset = library.assets.find(item => item.id === `illustration_${originalId}`);
  assert.equal(job?.status, "ready", "Pending, failed submissions and unknown original jobs cannot be rerolled");
  assert.ok(asset && asset.keyframe?.gate === "failed" && asset.keyframe.passed === false, "Only a ready failed camera-gate output can be retried");
  assert.equal(asset.accepted, false); assert.equal(asset.historical, false);
  assert.equal(asset.view_dependency.view_id, phaseState.source.view_id);
  assert.equal(approval.failed_job_id, originalId); assert.equal(approval.failed_asset_id, asset.id); assert.equal(approval.failed_sha256, asset.sha256);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof approval.reason === "string" && approval.reason.trim().length > 0 && approval.reason.length <= 2000, "Record the observed failure reason");
  assert.ok(Number.isFinite(Date.parse(approval.approved_at)), "Explicit retry approval time is required");
  if (phaseState.retry) assert.deepEqual(phaseState.retry.approval, approval, "The one retry approval changed after it was reserved");
  if (retry) {
    assert.ok(["prepared", "acknowledged"].includes(retry.status), "Uncertain retry request must be reconciled, never rerolled");
    assert.equal(retry.body.action, "generate_keyframe"); assert.equal(retry.body.model, quote.model);
    assert.equal(retry.body.prompt, ILLUSTRATION_RETRY_PROMPT, "The bounded retry prompt changed");
    assert.deepEqual(retry.body.parameters, quote.parameters); assert.equal(retry.reserved_usd, quote.reservation);
    assert.equal(retry.body.id, manifest.request_ids["illustration-retry"]);
    if (retry.status === "acknowledged") assert.equal(retry.response.job.id, retry.body.id);
  }
  assert.ok(Object.entries(manifest.actions).filter(([key]) => key.startsWith("illustration:"))
    .every(([, action]) => !["sent", "unknown", "rejected"].includes(action.status)), "An unreconciled illustration request blocks another paid claim");
  const known = new Set([originalId, retry?.body.id].filter(Boolean));
  assert.ok(library.jobs.every(item => known.has(item.id) && item.status !== "submission_unknown"), "An unfamiliar or uncertain job blocks the explicit retry");
  assert.ok(library.assets.every(item => known.has(item.id.replace(/^illustration_/, ""))), "An unfamiliar output blocks the explicit retry");
  assert.ok(Object.keys(manifest.actions).filter(key => key.startsWith("illustration:keyframe")).every(key => ["illustration:keyframe", "illustration:keyframe-retry"].includes(key)), "Only one explicit retry is allowed");
  return { approval, asset };
}

async function immutableJson(directory, file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2)), path = join(directory, file);
  let handle;
  try {
    handle = await open(path, "wx", 0o600); await handle.writeFile(bytes); await handle.sync();
    const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(hash(await readFile(path)), hash(bytes), "The original frozen illustration receipt changed");
  } finally { if (handle) await handle.close(); }
  return { file, sha256: hash(bytes), bytes: bytes.length };
}

export async function runKnownIllustrationRetry(ctx) {
  const { manifest, phaseState, library, originalId, quote, path, post, id, persist, directory, log } = ctx;
  const checked = verifyKnownIllustrationRetry({ manifest, phaseState, library, originalId, quote });
  if (!checked) return null;
  const result = phaseState.original_result ?? phaseState.result;
  assert.ok(result?.submitted && result.accepted === false && result.assets?.length === 1, "Preserve the known failed original result before retrying");
  assert.equal(result.assets[0].id, checked.asset.id); assert.equal(result.assets[0].sha256, checked.asset.sha256);
  assert.deepEqual(result.source, phaseState.source, "Original result source differs from the reviewed retry source");
  assert.equal(manifest.actions["illustration:keyframe"].path, path);
  assert.ok(["image/png", "image/jpeg"].includes(checked.asset.content_type), "Original candidate image receipt type is missing");
  const originalBytes = await readFile(join(directory, `${checked.asset.id}.${checked.asset.sha256}.${checked.asset.content_type === "image/png" ? "png" : "jpg"}`));
  assert.equal(hash(originalBytes), checked.approval.failed_sha256, "Original failed bytes changed after root review");
  phaseState.original_result ??= structuredClone(result);
  phaseState.original_library ??= structuredClone(library);
  phaseState.original_receipts = [
    await immutableJson(directory, "illustration-original-result.json", phaseState.original_result),
    await immutableJson(directory, "illustration-original-candidates.json", phaseState.original_library),
  ];
  const retryId = await id("illustration-retry");
  phaseState.retry ??= { id: retryId, approval: structuredClone(checked.approval) };
  assert.equal(phaseState.retry.id, retryId); await persist();
  await log("known_illustration_retry_approved", { original_job_id: originalId, original_asset_id: checked.asset.id,
    original_sha256: checked.asset.sha256, retry_id: retryId, reservation_usd: quote.reservation });
  return post("keyframe-retry", path, { action: "generate_keyframe", id: retryId, prompt: ILLUSTRATION_RETRY_PROMPT,
    confirmed: true, art: false, ...quote }, quote.reservation);
}
