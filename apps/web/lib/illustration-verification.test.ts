import { describe, expect, it } from "vitest";
import type { IllustrationKeyframe } from "./place-view";
import { reviewedKeyframe, verifiedKeyframe } from "./illustration-verification";

const sha = "a".repeat(64), candidate = "b".repeat(64);
const receipt = (): IllustrationKeyframe => ({ version: 1, stage: "chain", object_id: "inn", gate: "passed", chosen: 0, passed: true, sky_pinned: true,
  candidates: [{ iou: 0.75, centre_dx: 0, centre_dy: 0, area_ratio: 1, painted: 30, passed: true }],
  final_image: { version: 1, sha256: sha, candidate_sha256: candidate, width: 64, height: 64, method: "depth_warp_v1",
    invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 3000, changed_protected_pixels: 0 } } });
describe("keyframe verification", () => {
  it("separates camera/paint and final-byte checks from an owner's content review", () => {
    const k = receipt();
    expect(verifiedKeyframe(k, sha)).toBe(true); expect(reviewedKeyframe(k, sha)).toBe(false);
    k.content_approval = { version: 1, method: "owner_review", sha256: sha, reviewed_at: "2026-10-03T00:00:00Z" };
    expect(reviewedKeyframe(k, sha)).toBe(true);
    k.content_approval.sha256 = candidate; expect(reviewedKeyframe(k, sha)).toBe(false);
  });
  it("does not invent a universal IoU approval threshold", () => {
    const k = receipt(); k.candidates[0]!.iou = 0.2;
    expect(verifiedKeyframe(k, sha)).toBe(true);
  });
  it.each(["failed", "unmeasured", "missing", "wrong hash", "wrong candidate", "chosen failed", "dimensions", "alpha", "composition", "protected", "wrong method"])("refuses %s evidence", problem => {
    const k = receipt(), final = k.final_image!;
    if (problem === "failed" || problem === "unmeasured") k.gate = problem;
    if (problem === "missing") delete k.final_image;
    if (problem === "wrong hash") final.sha256 = candidate;
    if (problem === "wrong candidate") final.candidate_sha256 = "not-a-hash";
    if (problem === "chosen failed") k.candidates[0]!.passed = false;
    if (problem === "dimensions") final.width = NaN;
    if (problem === "alpha") final.invariants.opaque = false;
    if (problem === "composition") final.invariants.composition = false;
    if (problem === "protected") final.invariants.changed_protected_pixels = 1;
    if (problem === "wrong method") final.method = "candidate";
    expect(verifiedKeyframe(k, sha)).toBe(false); expect(reviewedKeyframe(k, sha)).toBe(false);
  });
});
