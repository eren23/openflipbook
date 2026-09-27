import { expect, it } from "vitest";
import { motionStudyFixture } from "../tests/fixtures/motion-study";
import { evaluateMotionReview, motionComparisonPlan, parseMotionReview, type MotionReviewInput } from "./motion-comparison";
const plan = () => motionComparisonPlan(motionStudyFixture());
const media = { width: 1280, height: 960, duration: 6 };
const matching = (): MotionReviewInput => {
  const p = plan(); return { observations: p.frames.flatMap((frame, i) => p.landmarks.map((landmark, j) => ({ frame: i,
    object_id: landmark.id, observed_seconds: frame.seconds, bounds: frame.bounds[j]! }))),
  visual: { architecture: "pass", occlusion_order: "pass", continuous_motion: "pass" }, notes: "Synthetic matching measurements" };
};
it("freezes deterministic measurable landmarks, sample times and initial tolerances", () => {
  expect(plan()).toEqual(plan()); expect(plan().issues).toEqual([]); expect(plan().landmarks.map(v => v.id)).toEqual(["target", "left", "right"]);
  expect(plan().tolerances).toMatchObject({ position: .03, relative_size: .2, direction_cosine: .7 });
});
it("does not use road patches or unregistered mask identities as neighboring landmarks", () => {
  const study = motionStudyFixture();
  study.source.definitions[0]!.definition.objects[1]!.kind = "path";
  study.source.definitions[0]!.definition.objects.pop();
  const result = motionComparisonPlan(study);
  expect(result.landmarks.map(v => v.id)).toEqual(["target"]);
  expect(result.issues).toContain("Two measurable neighboring landmarks are required throughout the path");
});
it.each(["clipped", "unknown", "neighbor", "stationary"])("does not certify a %s reference", kind => {
  const study = motionStudyFixture();
  if (kind === "clipped") study.frames[0]!.measurements.landmarks[0]!.touches_frame = true;
  if (kind === "unknown") study.frames[0]!.measurements.unknown_pixels = 50000;
  if (kind === "neighbor") for (const frame of study.frames) frame.measurements.landmarks.pop();
  if (kind === "stationary") for (const frame of study.frames) frame.measurements = structuredClone(study.frames[0]!.measurements);
  expect(motionComparisonPlan(study).issues.length).toBeGreaterThan(0);
});
it("passes complete matching observations only with explicit human checks", () => {
  expect(evaluateMotionReview(plan(), parseMotionReview(matching(), plan()), media)).toMatchObject({ status: "pass", provenance: "human_measurements_not_independent_attestation" });
  const review = matching(); review.visual.occlusion_order = "unreviewed";
  expect(evaluateMotionReview(plan(), review, media).status).toBe("incomplete");
});
it.each(["drift", "size", "missing", "time", "architecture", "aspect", "duration", "reverse"])("fails %s instead of accepting a smooth-looking clip", kind => {
  const review = matching(), m = { ...media };
  const item = review.observations.at(-1)!;
  if (kind === "drift") { item.bounds = [...item.bounds!] as [number, number, number, number]; item.bounds[0] -= .1; item.bounds[2] -= .1; }
  if (kind === "size") item.bounds = [item.bounds![0], .1, item.bounds![2], .9];
  if (kind === "missing") item.bounds = null;
  if (kind === "time") item.observed_seconds -= .5;
  if (kind === "architecture") review.visual.architecture = "fail";
  if (kind === "aspect") m.width = 1920;
  if (kind === "duration") m.duration = 5;
  if (kind === "reverse") for (const observation of review.observations) {
    const shift = observation.frame * -.04; observation.bounds = observation.bounds!.map((n, i) => i % 2 === 0 ? n + shift : n) as [number, number, number, number];
  }
  expect(evaluateMotionReview(plan(), review, m).status).toBe("fail");
});
it("reports absent observations as incomplete and retains failures with missing data", () => {
  const review = matching(); review.observations.pop(); expect(evaluateMotionReview(plan(), review, media).status).toBe("incomplete");
  review.visual.continuous_motion = "fail"; expect(evaluateMotionReview(plan(), review, media).status).toBe("fail");
});
it.each(["duplicate", "unknown", "nan", "outside", "reversed", "extra", "notes", "visual"])("rejects invalid %s review input", kind => {
  const review = matching(); const raw = review as unknown as Record<string, unknown>;
  if (kind === "duplicate") review.observations[1] = structuredClone(review.observations[0]!);
  if (kind === "unknown") review.observations[0]!.object_id = "foreign";
  if (kind === "nan") review.observations[0]!.bounds![0] = NaN;
  if (kind === "outside") review.observations[0]!.bounds![0] = -1;
  if (kind === "reversed") review.observations[0]!.bounds = [.8, .2, .1, .3];
  if (kind === "extra") raw.verdict = "pass";
  if (kind === "notes") review.notes = "x".repeat(2001);
  if (kind === "visual") raw.visual = { architecture: "pass" };
  expect(() => parseMotionReview(review, plan())).toThrow("Invalid motion review");
});
