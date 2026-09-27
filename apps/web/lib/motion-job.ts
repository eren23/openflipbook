import type { MeshJobState } from "./mesh-asset";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionComparisonPlan, MotionReviewInput, evaluateMotionReview } from "./motion-comparison";
export interface FrozenMotionComparison { sha256: string; plan: MotionComparisonPlan }
export interface MotionJob {
  id: string; study_id: string; model: string; status: MeshJobState; reservation: number;
  created_at: string; error?: string; asset_id?: string;
}
export interface MotionJobDoc extends Omit<MotionJob, "created_at"> {
  _id: string; session_id: string; created_at: Date; request_sha256: string;
  study_sha256: string; preparation_sha256: string; parameters: MotionStudyDoc["preparation"]["parameters"];
  adapter: string; ledger_ids: string[]; request_id?: string;
  comparison?: FrozenMotionComparison;
  submission_token?: string; submission_deadline?: Date; submission_started_at?: Date;
  work_token?: string; work_until?: Date; next_check?: Date;
  provider_result?: { status: "ready"; video: { url: string }; expanded_prompt?: string | null; audio_status?: string };
  original?: MotionFile; silent?: MotionFile; refresh_result?: boolean;
  media?: MotionAssetDoc["media"];
}
export interface MotionFile { key: string; bytes: number; sha256: string }
export interface MotionAssetDoc {
  _id: string; id: string; session_id: string; study_id: string; study_sha256: string;
  preparation_sha256: string; model: string; adapter: string; request_id: string;
  parameters: MotionJobDoc["parameters"]; expanded_prompt: string | null;
  original: MotionFile; silent: MotionFile; created_at: Date;
  comparison?: FrozenMotionComparison;
  forked_from?: { session_id: string; asset_id: string; study_sha256: string };
  restored_from?: { session_id: string; asset_id: string; study_sha256: string; archive_sha256: string; provenance: "user_supplied_archive" };
  media: { width: number; height: number; duration: number; audio_streams: number; source_audio_streams: number; derivative: "silent_streamcopy_v1" };
}
export interface MotionReviewDoc {
  _id: string; id: string; session_id: string; study_id: string; asset_id: string;
  request_sha256: string; comparison_sha256: string; video_sha256: string;
  review: MotionReviewInput; outcome: ReturnType<typeof evaluateMotionReview>; created_at: Date;
}
export const wireMotionJob = (job: MotionJobDoc): MotionJob => ({ id: job.id, study_id: job.study_id, model: job.model,
  status: job.status, reservation: job.reservation, created_at: job.created_at.toISOString(),
  ...(job.error ? { error: job.error } : {}), ...(job.asset_id ? { asset_id: job.asset_id } : {}) });
