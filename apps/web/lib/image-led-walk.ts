/** Image-led routes describe positions in the original artwork, never recovered metres or a 3D camera. */
export const IMAGE_LED_WALK_PROFILE = "image-led-v1" as const;
export const IMAGE_LED_MAP_FRAME = "original-image-normalized" as const;
export type ImageLedStillModel = "fal-ai/nano-banana-pro/edit" | "openai/gpt-image-2.5/sunburst/edit" | "blackforestlabs/flux-3/edit-image" | "bytedance/seedream/v5/pro/edit";
export interface ImageLedPoint { x: number; y: number }
export interface ImageLedFile { key: string; sha256: string; bytes: number; content_type: "image/png" | "image/jpeg" | "video/mp4" }
export interface ImageLedImage extends ImageLedFile { width: number; height: number }
export interface ImageLedPlayback { kind: "contain-jpeg-v1"; width: number; height: number; background: "#20231e" }
/** Repair images remain unapproved. The full quote also binds the route and predecessor. */
export interface ImageLedRepair { checkpoint_index: number; source_sha256: string; target_sha256: string; image: ImageLedImage; mask?: ImageLedImage }
export type ImageLedReview = "pending" | "approved" | "rejected";
export type ImageLedStepStatus = "empty" | "scheduled" | "submitting" | "queued" | "running" | "ready" | "submission_unknown" | "storage_failed" | "failed";
export interface ImageLedLandmark {
  id: string; entity_id: string | null; label: string; visual: string;
  source_rectangle: { left: number; top: number; width: number; height: number };
  reference_kind: "reviewed_source_crop" | "identity_anchor" | "appearance_bbox" | "owner_reviewed_crop";
  image: ImageLedImage;
}
export interface ImageLedSource {
  node_id: string; image_key: string; image: ImageLedImage;
  map_frame: { bounds: { x: number; y: number; w: number; h: number }; parent_id: string | null };
  source_projection: "illustrated_oblique_or_unknown";
  binding_sha256: string;
}
export interface ImageLedStill {
  index: number; status: ImageLedStepStatus; job_id?: string;
  raw?: ImageLedImage; image?: ImageLedImage;
  derivative?: { kind: "uniform-scale-jpeg-v1" | "contain-jpeg-v1"; source_sha256: string; crop: false; stretch: false; canvas?: ImageLedPlayback };
  review: { identity: ImageLedReview; route: ImageLedReview; spatial: "unmeasured"; sha256?: string; reviewed_at?: string; notes?: string };
  error?: string;
}
export interface ImageLedLeg {
  index: number; from: number; to: number; status: ImageLedStepStatus; job_id?: string;
  original?: ImageLedFile; video?: ImageLedFile;
  media?: { width: number; height: number; duration: number; audio_streams: number; source_audio_streams: number; derivative: "silent_streamcopy_v1" };
  review: { temporal: ImageLedReview; sha256?: string; reviewed_at?: string; notes?: string };
  error?: string;
}
export interface ImageLedSeed { view_id: string; asset_id: string; sha256: string; review_sha256: string; image: ImageLedImage }
/** Portable content. Execution state belongs to image_led_walk_steps and must never resume after import. */
export interface ImageLedWalkDoc {
  _id: string; id: string; session_id: string; profile: typeof IMAGE_LED_WALK_PROFILE;
  created_at: Date; updated_at: Date; request_sha256: string;
  status: "draft" | "active" | "needs_review" | "complete" | "archived";
  source: ImageLedSource; landmarks: ImageLedLandmark[];
  route: { frame: typeof IMAGE_LED_MAP_FRAME; points: ImageLedPoint[]; map_sha256: string; sha256: string };
  prompt: string; seed?: ImageLedSeed; frames: ImageLedStill[]; legs: ImageLedLeg[];
  revision: number;
  archive_provenance?: { version: 1; source_session_id: string; source_id: string; original_status: string };
}
export interface ImageLedWalkQuote {
  version: 1; profile: typeof IMAGE_LED_WALK_PROFILE; kind: "still" | "video"; index: number;
  model: string; parameters: Record<string, unknown>; reservation: number; retry_allowance: 0;
  source_sha256: string; binding_sha256: string; route_sha256: string; inputs_sha256: string;
  quote_sha256: string; spatial_validation: "unmeasured";
  repair?: ImageLedRepair;
  playback?: ImageLedPlayback;
}
export interface ImageLedWalkWire extends Omit<ImageLedWalkDoc, "_id" | "created_at" | "updated_at" | "source" | "landmarks" | "frames" | "legs" | "seed"> {
  created_at: string; updated_at: string;
  source: Omit<ImageLedSource, "image_key" | "image"> & { image: Omit<ImageLedImage, "key">; image_url: string };
  landmarks: (Omit<ImageLedLandmark, "image"> & { image: Omit<ImageLedImage, "key">; image_url: string })[];
  frames: (Omit<ImageLedStill, "raw" | "image"> & { raw?: Omit<ImageLedImage, "key">; image?: Omit<ImageLedImage, "key">; image_url?: string; raw_url?: string })[];
  legs: (Omit<ImageLedLeg, "original" | "video"> & { original?: Omit<ImageLedFile, "key">; video?: Omit<ImageLedFile, "key">; video_url?: string })[];
  seed?: Omit<ImageLedSeed, "image"> & { image: Omit<ImageLedImage, "key"> };
}
export interface ImageLedWalkDetail { walk: ImageLedWalkWire; quote: ImageLedWalkQuote | null; reason?: string }
export interface ImageLedWalkCreate {
  id: string; source_node_id: string;
  map_frame: ImageLedSource["map_frame"]; points: ImageLedPoint[]; landmark_ids: string[];
  prompt?: string; seed?: { view_id: string; asset_id: string; sha256: string };
  /** A missing reference can be reviewed explicitly; rectangles are normalized SOURCE pixels, never a physical footprint. */
  landmark_crops?: { id: string; x: number; y: number; w: number; h: number; confirmed: true }[];
}
