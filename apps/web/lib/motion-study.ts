import type { SavedPlaceView, ViewCamera, ViewPass, ViewSource } from "./place-view";
import type { prepareCameraMotion } from "./camera-motion";
import type { measureMotionLandmarks } from "./camera-motion-reference";
import type { CameraPathCheck } from "./camera-path";

export interface MotionStudy {
  id: string; label: string; view_id: string; created_at: string;
  preparation_sha256: string; historical: boolean;
  status: "reference_only"; provenance: "client_rendered_saved_geometry";
  preflight: "not_server_attested";
  client_preflight?: CameraPathCheck | null;
  frames: { time: number; seconds: number; camera: ViewCamera;
    measurements: ReturnType<typeof measureMotionLandmarks> }[];
}
export interface MotionStudyDoc extends Omit<MotionStudy, "historical"> {
  _id: string; session_id: string; request_sha256: string;
  forked_from?: { session_id: string; study_id: string; study_sha256: string };
  restored_from?: { session_id: string; study_id: string; study_sha256: string; archive_sha256: string; provenance: "user_supplied_archive" };
  preparation: ReturnType<typeof prepareCameraMotion>;
  source: { view: SavedPlaceView; definitions: ViewSource[];
    image: { asset_id: string | null; key: string; sha256: string; bytes: number } };
  files: Record<ViewPass, { key: string; sha256: string; bytes: number }>[];
}
