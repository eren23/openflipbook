import type { MotionStudyDoc } from "./motion-study";
import { CreatorError } from "./creator-error";

export type MotionBounds = [number, number, number, number];
export const MOTION_COMPARISON_VERSION = "visible-bounds-human-v1";
export const MOTION_VISUAL_CHECKS = ["architecture", "occlusion_order", "continuous_motion"] as const;
export type MotionVisualCheck = typeof MOTION_VISUAL_CHECKS[number];
export type MotionAssessment = "pass" | "fail" | "unreviewed";
export interface MotionComparisonPlan {
  version: typeof MOTION_COMPARISON_VERSION;
  provenance: "client_geometry_masks_human_video_bounds";
  width: number; height: number; duration: number;
  tolerances: { position: number; relative_size: number; direction_cosine: number; motion_signal: number; seek_seconds: number; duration_seconds: number; aspect_ratio: number };
  landmarks: { id: string; label: string }[];
  frames: { seconds: number; bounds: (MotionBounds | null)[] }[];
  issues: string[];
}
export interface MotionObservation {
  frame: number; object_id: string; observed_seconds: number;
  bounds: MotionBounds | null;
}
export interface MotionReviewInput {
  observations: MotionObservation[];
  visual: Record<MotionVisualCheck, MotionAssessment>;
  notes: string;
}

const boundsValid = (value: unknown): value is MotionBounds => Array.isArray(value) && value.length === 4
  && value.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && value[0] < value[2] && value[1] < value[3];
const center = (b: MotionBounds) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] as const;

type ComparisonReference = {
  preparation: { path: Pick<MotionStudyDoc["preparation"]["path"], "target_id">; parameters: Pick<MotionStudyDoc["preparation"]["parameters"], "duration"> };
  source: { view: Pick<MotionStudyDoc["source"]["view"], "width" | "height">; definitions: Pick<MotionStudyDoc["source"]["definitions"][number], "definition">[] };
  frames: Pick<MotionStudyDoc["frames"][number], "seconds" | "measurements">[];
};

// Freeze these initial calibration tolerances before a provider submission.
// Bounding-box centers are not mask centroids or persistent surface features.
export function motionComparisonPlan(study: ComparisonReference): MotionComparisonPlan {
  const frames = study.frames, target = study.preparation.path.target_id!;
  const objects = new Map(study.source.definitions.flatMap(source => source.definition.objects.map(object => [object.id, object] as const)));
  // Road patches merge visually with adjoining ground. Use distinct world
  // objects, not mask-only identities or road area, as calibration anchors.
  const usable = (id: string) => objects.has(id) && objects.get(id)!.kind !== "path" && frames.every(frame => {
    const item = frame.measurements.landmarks.find(item => item.object_id === id);
    return item && item.fraction >= .001 && !item.touches_frame && boundsValid(item.bounds)
      && item.bounds[2] - item.bounds[0] >= .01 && item.bounds[3] - item.bounds[1] >= .01;
  });
  const ids = [...new Set(frames.flatMap(frame => frame.measurements.landmarks.map(item => item.object_id)))];
  const area = (id: string) => Math.min(...frames.map(frame => frame.measurements.landmarks.find(item => item.object_id === id)?.fraction ?? 0));
  const neighbors = ids.filter(id => id !== target && usable(id)).sort((a, b) => area(b) - area(a) || a.localeCompare(b)).slice(0, 2);
  const selected = [target, ...neighbors];
  const issues: string[] = [];
  if (frames.length < 5 || frames[0]?.seconds !== 0 || frames.at(-1)?.seconds !== study.preparation.parameters.duration)
    issues.push("Reference must cover the complete path with at least five samples");
  if (!usable(target)) issues.push("Target must be visible, unclipped and measurable in every reference sample");
  if (neighbors.length < 2) issues.push("Two measurable neighboring landmarks are required throughout the path");
  if (frames.some(frame => frame.measurements.unknown_pixels > study.source.view.width * study.source.view.height * .01))
    issues.push("Reference masks contain too many unknown pixels");
  const plan: MotionComparisonPlan = {
    version: MOTION_COMPARISON_VERSION, provenance: "client_geometry_masks_human_video_bounds",
    width: study.source.view.width, height: study.source.view.height, duration: study.preparation.parameters.duration,
    tolerances: { position: .03, relative_size: .2, direction_cosine: .7, motion_signal: .015, seek_seconds: .1, duration_seconds: .25, aspect_ratio: .01 },
    landmarks: selected.map(id => ({ id, label: objects.get(id)?.label || id })),
    frames: frames.map(frame => ({ seconds: frame.seconds, bounds: selected.map(id => frame.measurements.landmarks.find(item => item.object_id === id)?.bounds ?? null) })), issues,
  };
  const first = plan.frames[0], last = plan.frames.at(-1);
  if (!first || !last || !selected.some((_id, i) => {
    const a = first.bounds[i], b = last.bounds[i]; if (!a || !b) return false;
    const ca = center(a), cb = center(b);
    return Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) >= plan.tolerances.motion_signal
      || Math.abs((b[2] - b[0]) / (a[2] - a[0]) - 1) >= .1;
  })) issues.push("Reference movement is too small for this calibration comparison");
  return plan;
}

export function parseMotionReview(value: unknown, plan: MotionComparisonPlan): MotionReviewInput {
  const invalid = () => { throw new CreatorError("Invalid motion review measurements", 400); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["observations", "visual", "notes"].includes(key)) || !Array.isArray(input.observations)
    || input.observations.length > plan.frames.length * plan.landmarks.length || typeof input.notes !== "string" || input.notes.length > 2000
    || !input.visual || typeof input.visual !== "object" || Array.isArray(input.visual)) return invalid();
  const visual = input.visual as Record<string, unknown>;
  if (Object.keys(visual).length !== MOTION_VISUAL_CHECKS.length || MOTION_VISUAL_CHECKS.some(key => typeof visual[key] !== "string" || !["pass", "fail", "unreviewed"].includes(visual[key]))) return invalid();
  const seen = new Set<string>();
  const observations = input.observations.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const item = value as MotionObservation;
    if (Object.keys(item).some(key => !["frame", "object_id", "observed_seconds", "bounds"].includes(key))
      || !Number.isInteger(item.frame) || item.frame < 0 || item.frame >= plan.frames.length
      || !plan.landmarks.some(landmark => landmark.id === item.object_id) || !Number.isFinite(item.observed_seconds)
      || item.observed_seconds < 0 || item.observed_seconds > 20 || item.bounds !== null && !boundsValid(item.bounds)) return invalid();
    const key = `${item.frame}:${item.object_id}`; if (seen.has(key)) return invalid(); seen.add(key);
    return { frame: item.frame, object_id: item.object_id, observed_seconds: item.observed_seconds, bounds: item.bounds };
  });
  return { observations, visual: visual as MotionReviewInput["visual"], notes: input.notes };
}

export function evaluateMotionReview(plan: MotionComparisonPlan, review: MotionReviewInput, media: { width: number; height: number; duration: number }) {
  const failures: string[] = [], incomplete = [...plan.issues], t = plan.tolerances;
  const observations = new Map(review.observations.map(item => [`${item.frame}:${item.object_id}`, item]));
  const rows: { frame: number; object_id: string; position_error: number | null; size_error: number | null }[] = [];
  if (plan.version !== MOTION_COMPARISON_VERSION) incomplete.push("Unsupported comparison version");
  if (![media.width, media.height, media.duration].every(n => Number.isFinite(n) && n > 0)) failures.push("Invalid video metadata");
  if (Math.abs(media.duration - plan.duration) > t.duration_seconds) failures.push("Video duration differs from the frozen path");
  if (Math.abs((media.width / media.height) / (plan.width / plan.height) - 1) > t.aspect_ratio) failures.push("Video aspect ratio differs from the reference");
  for (const [frameIndex, frame] of plan.frames.entries()) {
    for (const [index, landmark] of plan.landmarks.entries()) {
      const key = `${frameIndex}:${landmark.id}`, observed = observations.get(key), expected = frame.bounds[index];
      if (!observed) { incomplete.push(`Missing sample ${frameIndex + 1}: ${landmark.label}`); continue; }
      if (Math.abs(observed.observed_seconds - frame.seconds) > t.seek_seconds) { failures.push(`Wrong video time at sample ${frameIndex + 1}: ${landmark.label}`); continue; }
      if (!expected) { incomplete.push(`Unmeasurable reference: ${landmark.label}`); continue; }
      if (!observed.bounds) { failures.push(`Missing visible landmark at sample ${frameIndex + 1}: ${landmark.label}`); rows.push({ frame: frameIndex, object_id: landmark.id, position_error: null, size_error: null }); continue; }
      const actual = observed.bounds, ca = center(actual), ce = center(expected);
      const position = Math.max(Math.abs(ca[0] - ce[0]), Math.abs(ca[1] - ce[1]));
      const size = Math.max(Math.abs((actual[2] - actual[0]) / (expected[2] - expected[0]) - 1), Math.abs((actual[3] - actual[1]) / (expected[3] - expected[1]) - 1));
      rows.push({ frame: frameIndex, object_id: landmark.id, position_error: position, size_error: size });
      if (position > t.position + 1e-12) failures.push(`Position drift at sample ${frameIndex + 1}: ${landmark.label}`);
      if (size > t.relative_size + 1e-12) failures.push(`Size drift at sample ${frameIndex + 1}: ${landmark.label}`);
      if (actual.some(n => n === 0 || n === 1)) failures.push(`Frame clipping at sample ${frameIndex + 1}: ${landmark.label}`);
      if (frameIndex === 0) continue;
      const priorExpected = plan.frames[frameIndex - 1]!.bounds[index], priorActual = observations.get(`${frameIndex - 1}:${landmark.id}`)?.bounds;
      if (!priorExpected || !priorActual) continue;
      const pe = center(priorExpected), pa = center(priorActual), e = [ce[0] - pe[0], ce[1] - pe[1]], a = [ca[0] - pa[0], ca[1] - pa[1]];
      const el = Math.hypot(...e), al = Math.hypot(...a);
      if (el >= t.motion_signal && (al < t.motion_signal / 3 || (e[0]! * a[0]! + e[1]! * a[1]!) / el / al < t.direction_cosine))
        failures.push(`Wrong landmark motion at sample ${frameIndex + 1}: ${landmark.label}`);
    }
  }
  for (const key of MOTION_VISUAL_CHECKS) {
    if (review.visual[key] === "fail") failures.push(`Human review failed: ${key}`);
    else if (review.visual[key] !== "pass") incomplete.push(`Human review required: ${key}`);
  }
  return { status: failures.length ? "fail" as const : incomplete.length ? "incomplete" as const : "pass" as const,
    provenance: "human_measurements_not_independent_attestation" as const, failures, incomplete, measurements: rows };
}
