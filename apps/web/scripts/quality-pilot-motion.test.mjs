import assert from "node:assert/strict";
import test from "node:test";
import { motionReferenceReviewed, verifyPilotMotionQuote } from "./quality-pilot-motion.mjs";

const approved = { model: "minimax/h3-max/camera-controls", adapter: "h3-source-relative-v2-measured", reservation: .4 };
const library = () => ({ quote: { ...approved }, study_sha256: "owned-study", comparison: { sha256: "frozen-criteria",
  plan: { duration: 5, issues: [], landmarks: [{ id: "workshop" }, { id: "bakery" }, { id: "bookshop" }],
    frames: [0, 1.25, 2.5, 3.75, 5].map(seconds => ({ seconds })) } } });

test("motion refuses changed provider quotes and incomplete pre-submission references", () => {
  verifyPilotMotionQuote(library(), approved);
  const changes = [value => { value.quote = null; }, value => { value.quote.model = "other"; },
    value => { value.quote.adapter = "uncalibrated"; }, value => { value.quote.reservation = .8; },
    value => { value.comparison.plan.duration = 6; }, value => { value.comparison.plan.issues.push("Target occluded"); },
    value => { value.comparison.plan.landmarks.pop(); }, value => { value.comparison.plan.frames.pop(); }];
  for (const change of changes) { const value = library(); change(value); assert.throws(() => verifyPilotMotionQuote(value, approved)); }
});

test("root review authorizes only the exact saved study and comparison", () => {
  const value = library(), manifest = { reviews: { motion_reference: { approved: true,
    study_sha256: value.study_sha256, comparison_sha256: value.comparison.sha256, reviewed_at: new Date().toISOString() } } };
  assert.equal(motionReferenceReviewed(manifest, value), true);
  assert.equal(motionReferenceReviewed({}, value), false);
  assert.equal(motionReferenceReviewed(manifest, { ...value, study_sha256: "different-world" }), false);
  assert.equal(motionReferenceReviewed(manifest, { ...value, comparison: { ...value.comparison, sha256: "new-path" } }), false);
  manifest.reviews.motion_reference.reviewed_at = "invalid-date";
  assert.equal(motionReferenceReviewed(manifest, value), false);
  manifest.reviews.motion_reference.reviewed_at = new Date().toISOString();
  manifest.reviews.motion_reference.approved = false;
  assert.equal(motionReferenceReviewed(manifest, value), false);
});
