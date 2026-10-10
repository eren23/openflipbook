/** Exact root approval of final image content; no generated image is autoaccepted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let verification;
const verifier = () => verification ??= tsImport("../lib/illustration-verification.ts", import.meta.url);
export function illustrationOutputReviewed(manifest, asset) {
  const review = manifest.reviews?.illustration_output;
  return review?.approved === true && review.asset_id === asset.id && review.sha256 === asset.sha256
    && Number.isFinite(Date.parse(review.reviewed_at));
}

export async function acceptPilotIllustrationOutput({ manifest, phaseState, get, post, persist, log, atomicJson, directory }) {
  assert.equal(phaseState.result?.assets?.length, 1, "Preserve the original one-candidate receipt before content review");
  const original = phaseState.result.assets[0], review = manifest.reviews?.illustration_output;
  if (!illustrationOutputReviewed(manifest, original)) {
    phaseState.awaiting_review = "illustration_output";
    phaseState.result.accepted = false;
    phaseState.result.assessment = review?.approved === false && review.asset_id === original.id && review.sha256 === original.sha256 ? "Root content review rejected this image; preserve the unaccepted candidate."
      : "Awaiting root review of the final image content; camera checks alone do not verify its architecture or visual style.";
    await persist(); await log("illustration_output_awaiting_review", { asset_id: original.id, sha256: original.sha256 });
    return { awaiting_review: true, accepted: false };
  }
  assert.match(original.id, /^[A-Za-z0-9_-]{1,160}$/); assert.match(original.sha256, /^[a-f0-9]{64}$/);
  assert.ok(["image/png", "image/jpeg"].includes(original.content_type));
  const bytes = await readFile(join(directory, `${original.id}.${original.sha256}.${original.content_type === "image/png" ? "png" : "jpg"}`));
  assert.equal(hash(bytes), original.sha256, "Final image bytes changed after root review");
  const path = `/api/world/${manifest.world.session_id}/views/${phaseState.source.view_id}/illustrations`;
  let library = await get(path), asset = library.assets.find(item => item.id === original.id);
  assert.ok(asset && asset.sha256 === original.sha256 && asset.view_dependency.view_id === phaseState.source.view_id, "Reviewed final image binding changed");
  assert.equal(library.historical, false); assert.equal(asset.historical, false);
  const { verifiedKeyframe, reviewedKeyframe } = await verifier();
  assert.ok(verifiedKeyframe(asset.keyframe, asset.sha256), "Final image lacks passing camera and byte verification");
  assert.ok(library.accepted_id === null || library.accepted_id === asset.id, "Another selected image needs its own review");
  if (library.accepted_id !== asset.id) {
    const saved = await post("accept-output", path, { action: "accept", id: asset.id, previous_id: null, reviewed_sha256: asset.sha256 });
    assert.equal(saved.accepted_id, asset.id); library = await get(path); asset = library.assets.find(item => item.id === original.id);
  }
  assert.ok(asset?.accepted && library.accepted_id === original.id && asset.sha256 === original.sha256);
  assert.ok(reviewedKeyframe(asset.keyframe, asset.sha256), "Reopened selection lacks content approval for its exact final bytes");
  phaseState.result.assets = [asset]; phaseState.result.accepted = true;
  phaseState.result.assessment = "Root reviewed this exact final image and saved its current illustration selection.";
  delete phaseState.awaiting_review;
  await atomicJson(join(directory, "illustration-accepted-library.json"), library); await persist();
  await log("illustration_output_accepted", { asset_id: asset.id, sha256: asset.sha256 });
  return { awaiting_review: false, accepted: true };
}
