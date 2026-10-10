import type { IllustrationKeyframe } from "./place-view";

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Camera/paint evidence plus offline invariants for these exact stored bytes. This is not content approval. */
export function verifiedKeyframe(keyframe: IllustrationKeyframe | undefined, sha256: string): boolean {
  const final = keyframe?.final_image, checks = final?.invariants;
  return !!keyframe && keyframe.version === 1 && ["first", "chain"].includes(keyframe.stage) && keyframe.gate === "passed" && keyframe.passed === true
    && Number.isSafeInteger(keyframe.chosen) && keyframe.chosen >= 0 && keyframe.candidates?.[keyframe.chosen]?.passed === true
    && !!final && final.version === 1 && hash(sha256) && final.sha256 === sha256 && hash(final.candidate_sha256)
    && [final.width, final.height].every(n => Number.isSafeInteger(n) && n >= 32 && n <= 1024)
    && final.method === (keyframe.stage === "chain" ? "depth_warp_v1" : "candidate")
    && (final.method !== "candidate" || final.candidate_sha256 === final.sha256)
    && !!checks && checks.dimensions === true && checks.opaque === true && checks.composition === true
    && Number.isSafeInteger(checks.protected_pixels) && checks.protected_pixels >= 0 && checks.protected_pixels <= final.width * final.height
    && checks.changed_protected_pixels === 0;
}

/** Only an owner's review of the final image makes it eligible as a saved illustration chain source. */
export function reviewedKeyframe(keyframe: IllustrationKeyframe | undefined, sha256: string): boolean {
  const approval = keyframe?.content_approval;
  return verifiedKeyframe(keyframe, sha256) && !!approval && approval.version === 1
    && approval.method === "owner_review" && approval.sha256 === sha256 && Number.isFinite(Date.parse(approval.reviewed_at));
}
