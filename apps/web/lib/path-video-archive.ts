import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import { illustrationDependency } from "./illustration-input";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionFile } from "./motion-job";
import type { PathVideoDoc, PathVideoKeyframe, LegAttempt } from "./path-video";
import { PATH_VIDEO_CAP_USD } from "./path-video";
import { MAX_PATH_VIDEO_SECONDS } from "./motion-video";

const attemptReceipt = (attempt: LegAttempt) => ({ status: attempt.status, cost: attempt.cost,
  ...(attempt.request_id ? { request_id: attempt.request_id } : {}), ...(attempt.prompt ? { prompt: attempt.prompt } : {}),
  ...(attempt.original ? { original: attempt.original } : {}), ...(attempt.cut ? { cut: attempt.cut } : {}), ...(attempt.metrics ? { metrics: attempt.metrics } : {}) });
function keyframeReceipt(frame: PathVideoKeyframe) {
  const evidence = (value: Pick<PathVideoKeyframe, "attempt" | "gate" | "result" | "file">) => ({
    ...(value.attempt ? { attempt: attemptReceipt(value.attempt) } : {}), ...(value.gate ? { gate: value.gate } : {}),
    ...(value.result ? { result: value.result } : {}), ...(value.file ? { file: value.file } : {}),
  });
  return { frame: frame.frame, time: frame.time, stage: frame.stage, ...evidence(frame),
    ...(frame.other ? { other: evidence(frame.other) } : {}), ...(frame.retry ? { retry: frame.retry } : {}),
    ...(frame.gate_object_id !== undefined ? { gate_object_id: frame.gate_object_id } : {}), ...(frame.gate_subject !== undefined ? { gate_subject: frame.gate_subject } : {}),
    ...(frame.dropped ? { dropped: true as const, drop_reason: frame.drop_reason } : {}), ...(frame.kept_reason ? { kept_reason: frame.kept_reason } : {}),
    ...(frame.chained_from !== undefined ? { chained_from: frame.chained_from } : {}) };
}

// A library receipt contains completed evidence, never execution claims,
// provider leases, reservation consent or the original world's ledger ids.
export function pathVideoReceipt(job: PathVideoDoc) {
  if (!["ready", "needs_review", "failed", "cancelled"].includes(job.status)) return null;
  if (!job.video && !job.keyframes.some(frame => frame.file)) return null;
  return { id: job.id, session_id: job.session_id, created_at: job.created_at, status: job.status,
    ...(job.study_id ? { study_id: job.study_id, study_sha256: job.study_sha256, preparation_sha256: job.preparation_sha256 } : {}),
    ...(job.place_id ? { place_id: job.place_id, view_ids: job.view_ids, views_sha256: job.views_sha256 } : {}),
    ...(job.keyframe_policy ? { keyframe_policy: job.keyframe_policy, accepted_anchors_sha256: job.accepted_anchors_sha256!, accepted_anchors: job.accepted_anchors!, retry_allowance: 0 as const } : {}),
    prompt: job.prompt, duration: job.duration, subject: job.subject, art: job.art,
    original_spend: { reservation: job.reservation, committed: job.committed },
    keyframes: job.keyframes.map(keyframeReceipt), legs: job.legs.map(leg => ({ seconds: leg.seconds, duration: leg.duration, cost: leg.cost, move: leg.move,
      attempts: leg.attempts.map(attemptReceipt), ...(leg.retry ? { retry: leg.retry } : {}), ...(leg.chosen !== undefined ? { chosen: leg.chosen } : {}),
      ...(leg.landed !== undefined ? { landed: leg.landed } : {}), ...(leg.dropped ? { dropped: true as const } : {}) })),
    ...(job.video ? { video: job.video } : {}), ...(job.media ? { media: job.media } : {}), ...(job.error ? { error: job.error } : {}),
    ...(job.archive_provenance ? { archive_provenance: job.archive_provenance } : {}) };
}
export type PathVideoReceipt = NonNullable<ReturnType<typeof pathVideoReceipt>>;
export interface PathVideoArchiveExport { receipts: PathVideoReceipt[]; files: (MotionFile & { file: string; data: Uint8Array })[] }

export function inertPathVideoReceipt(receipt: PathVideoReceipt, sessionId: string): PathVideoDoc {
  const attempt = (value: ReturnType<typeof attemptReceipt>) => ({ ...value, token: "archive" });
  const frame = (value: PathVideoReceipt["keyframes"][number]) => {
    const { attempt: original, other, ...rest } = value;
    const { attempt: otherAttempt, ...otherEvidence } = other ?? {};
    return { ...rest, ...(original ? { attempt: attempt(original) } : {}),
      ...(other ? { other: { ...otherEvidence, ...(otherAttempt ? { attempt: attempt(otherAttempt) } : {}) } } : {}) };
  };
  return { _id: `${sessionId}:${receipt.id}`, id: receipt.id, session_id: sessionId, created_at: new Date(receipt.created_at),
    status: receipt.status === "ready" ? "ready" : "cancelled", prompt: receipt.prompt, duration: receipt.duration, subject: receipt.subject, art: receipt.art,
    ...(receipt.study_id ? { study_id: receipt.study_id, study_sha256: receipt.study_sha256!, preparation_sha256: receipt.preparation_sha256! } : {}),
    ...(receipt.view_ids ? { place_id: receipt.place_id!, view_ids: receipt.view_ids, views_sha256: receipt.views_sha256! } : {}),
    ...(receipt.keyframe_policy ? { keyframe_policy: receipt.keyframe_policy, accepted_anchors_sha256: receipt.accepted_anchors_sha256!, accepted_anchors: receipt.accepted_anchors!, retry_allowance: 0 as const } : {}),
    request_sha256: viewHash({ archive_receipt: receipt }), reservation: 0, committed: 0, ledger_ids: [], funding_released: true,
    keyframe_reservation: 0, keyframe_parameters: {}, keyframes: receipt.keyframes.map(frame), legs: receipt.legs.map(leg => ({ ...leg, attempts: leg.attempts.map(attempt) })),
    ...(receipt.video ? { video: receipt.video } : {}), ...(receipt.media ? { media: receipt.media } : {}), ...(receipt.error ? { error: receipt.error } : {}),
    archive_provenance: receipt.archive_provenance ?? { version: 1, source_session_id: receipt.session_id, source_id: receipt.id,
      original_status: receipt.status, committed: receipt.original_spend.committed } };
}

export function assertPathReceiptSource(receipt: PathVideoReceipt, studies: readonly MotionStudyDoc[], views: readonly PlaceViewDoc[]) {
  if (Boolean(receipt.study_id) === Boolean(receipt.view_ids)) throw new CreatorError("Path video source is ambiguous", 409);
  if (receipt.study_id && (receipt.keyframe_policy || receipt.accepted_anchors || receipt.accepted_anchors_sha256 || receipt.retry_allowance !== undefined)) throw new CreatorError("Accepted-only metadata needs saved walk cameras", 409);
  if (receipt.study_id) {
    const study = studies.find(item => item.id === receipt.study_id);
    if (!study || viewHash(study) !== receipt.study_sha256 || study.preparation_sha256 !== receipt.preparation_sha256)
      throw new CreatorError("Path video study binding differs", 409);
  } else {
    const selected = receipt.view_ids!.map(id => views.find(view => view.id === id));
    if (selected.length < 2 || selected.length > 12 || selected.some(view => !view || view.root_place_id !== receipt.place_id)
      || new Set(receipt.view_ids).size !== selected.length || viewHash(selected.map(view => illustrationDependency(view!))) !== receipt.views_sha256)
      throw new CreatorError("Walk video checkpoint binding differs", 409);
    if (receipt.keyframe_policy) {
      const anchors = receipt.accepted_anchors;
      const route = receipt.keyframe_policy === "accepted-route-v1", count = route ? selected.length : 2;
      const inventoryDiffers = route ? receipt.duration !== 5 * (count - 1) || receipt.duration > MAX_PATH_VIDEO_SECONDS || .4 * (count - 1) > PATH_VIDEO_CAP_USD
        || receipt.keyframes.length !== count || receipt.legs.length !== count - 1
        || receipt.original_spend.reservation > .4 * (count - 1) + 1e-6 || receipt.original_spend.committed > receipt.original_spend.reservation + 1e-6
        || receipt.keyframes.some((frame, i) => frame.frame !== i || frame.time !== Math.round(i / (count - 1) * 1e6) / 1e6 || frame.attempt || frame.other || frame.dropped || frame.chained_from !== undefined)
        || receipt.legs.some(leg => leg.seconds !== 5 || leg.duration !== 5 || leg.cost !== .4 || leg.dropped || leg.attempts.length > 1 || leg.attempts.some(attempt => attempt.cost !== .4))
        || receipt.media && (receipt.media.width !== 688 || receipt.media.height !== 384 || !Number.isFinite(receipt.media.duration)
          || Math.abs(receipt.media.duration - receipt.duration) > Math.max(.1, receipt.legs.length / 24))
        || selected.some(view => view!.walk_checkpoint || view!.mode === "plan")
        || !Array.isArray(anchors) || new Set(anchors.map(anchor => anchor.asset_id)).size !== count
        : selected.length !== 2 || receipt.duration !== 5 || receipt.legs.length !== 1;
      if (!(["accepted-only-v1", "accepted-route-v1"] as string[]).includes(receipt.keyframe_policy) || receipt.retry_allowance !== 0 || inventoryDiffers || !receipt.art
        || !Array.isArray(anchors) || anchors.length !== count || viewHash(anchors) !== receipt.accepted_anchors_sha256
        || anchors.some((anchor, i) => anchor.view_id !== selected[i]!.id || anchor.camera_sha256 !== viewHash(selected[i]!.camera)
          || anchor.input_sha256 !== illustrationDependency(selected[i]!).input_sha256 || anchor.source_sha256 !== receipt.art!.sha256
          || ![anchor.sha256, anchor.input_sha256, anchor.camera_sha256, anchor.source_sha256, anchor.review_sha256].every(value => /^[a-f0-9]{64}$/.test(value))
          || !Number.isSafeInteger(anchor.bytes) || anchor.bytes < 1 || selected[i]!.width !== 688 || selected[i]!.height !== 384
          || receipt.keyframes[i]?.stage !== "source" || receipt.keyframes[i]?.file?.sha256 !== anchor.sha256 || receipt.keyframes[i]?.file?.bytes !== anchor.bytes))
        throw new CreatorError("Accepted-only anchor receipt differs from its preserved cameras or bytes", 409);
    } else if (receipt.accepted_anchors || receipt.accepted_anchors_sha256 || receipt.retry_allowance !== undefined) throw new CreatorError("Unbound accepted-only archive metadata", 409);
  }
}

export async function downloadPathVideoArchive(receipts: PathVideoReceipt[], studies: readonly MotionStudyDoc[], views: readonly PlaceViewDoc[],
  required: (key: string, label: string, expected?: MotionFile) => Promise<{ bytes: Uint8Array }>): Promise<PathVideoArchiveExport> {
  const files = new Map<string, PathVideoArchiveExport["files"][number]>();
  async function include(file: MotionFile, extension: string) {
    if (!file.key || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new CreatorError("Invalid saved path video file", 409);
    const prior = files.get(file.key);
    if (prior) { if (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes) throw new CreatorError("Conflicting saved path video bytes", 409); return; }
    const stored = await required(file.key, "path video content", file);
    files.set(file.key, { ...file, file: `path-videos/${files.size + 1}.${extension}`, data: stored.bytes });
  }
  for (const receipt of receipts) {
    assertPathReceiptSource(receipt, studies, views);
    if (receipt.art && !files.has(receipt.art.key)) {
      const stored = await required(receipt.art.key, "path video artwork");
      if (viewHashBytes(stored.bytes) !== receipt.art.sha256) throw new CreatorError("Saved path video artwork is corrupted", 503);
      files.set(receipt.art.key, { ...receipt.art, bytes: stored.bytes.length, file: `path-videos/${files.size + 1}.image`, data: stored.bytes });
    }
    for (const frame of receipt.keyframes) { if (frame.file) await include(frame.file, "image"); if (frame.other?.file) await include(frame.other.file, "image"); }
    for (const leg of receipt.legs) for (const attempt of leg.attempts) { if (attempt.original) await include(attempt.original, "mp4"); if (attempt.cut) await include(attempt.cut, "mp4"); }
    if (receipt.video) await include(receipt.video, "mp4");
    if (receipt.status === "ready" && (!receipt.video || !receipt.media)) throw new CreatorError("Saved path video media is missing", 409);
  }
  return { receipts, files: [...files.values()] };
}

const viewHashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
