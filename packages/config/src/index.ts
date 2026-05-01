export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export type GenerateMode = "query" | "tap" | "edit";

export type ImageTier = "fast" | "balanced" | "pro";

export type VideoTier = "fast" | "balanced" | "pro";

export interface GenerateRequestBody {
  query: string;
  aspect_ratio: AspectRatio;
  web_search: boolean;
  session_id: string;
  current_node_id: string;
  mode?: GenerateMode;
  image?: string;
  parent_query?: string;
  parent_title?: string;
  click?: { x_pct: number; y_pct: number };
  // Free-form note from the user, captured via cmd/ctrl-click on the image
  // ("show this from a cross-section", "explain like I'm 5"). Folded into the
  // planner query so the next page reflects the user's specific angle.
  click_hint?: string;
  image_tier?: ImageTier;
  image_model?: string;
  edit_instruction?: string;
  // BCP-47 short tag (e.g. "en", "tr", "ja"). When set, the planner +
  // click-resolver are instructed to emit titles, labels, and the click
  // subject in this language. Image labels render in-pixel via the model.
  output_locale?: string;
  // Hover-prefetched click resolution. When present, the SSE stream skips
  // the VLM call entirely on tap mode, cutting ~600-1200ms off the hop.
  prefetched_subject?: string;
  prefetched_style?: string;
  trace_id?: string;
}

export interface ResolveClickRequestBody {
  image_data_url: string;
  x_pct: number;
  y_pct: number;
  parent_title?: string;
  parent_query?: string;
  output_locale?: string;
  trace_id?: string;
}

export interface ResolveClickResponse {
  subject: string;
  style: string;
}

export interface GenerateProgressEvent {
  type: "progress";
  frame_index: number;
  jpeg_b64: string;
  trace_id?: string;
}

export interface GenerateFinalEvent {
  type: "final";
  image_data_url: string;
  page_title: string;
  image_model: string;
  prompt_author_model: string;
  session_id: string;
  final_prompt: string;
  trace_id?: string;
}

export interface GenerateErrorEvent {
  type: "error";
  message: string;
  trace_id?: string;
}

export type GenerateStage =
  | "click_resolving"
  | "click_resolved"
  | "planning"
  | "generating_image";

export interface GenerateStatusEvent {
  type: "status";
  stage: GenerateStage;
  page_title?: string;
  subject?: string;
  trace_id?: string;
}

export type GenerateEvent =
  | GenerateStatusEvent
  | GenerateProgressEvent
  | GenerateFinalEvent
  | GenerateErrorEvent;

export interface NodeRecord {
  id: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_url: string;
  image_model: string;
  prompt_author_model: string;
  created_at: string;
}

export interface NodeCreateRequest {
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_variants: Record<AspectRatio, string>;
  image_model: string;
  prompt_author_model: string;
}

export type LoopyStrategy = "anchor_loop" | "linear";

export interface LTXStreamStartMessage {
  action: "start";
  session_id: string;
  prompt: string;
  width: number;
  height: number;
  num_frames: number;
  frame_rate: number;
  max_segments: number;
  loopy_mode: boolean;
  loopy_strategy: LoopyStrategy;
  start_image: string;
  target_image: string;
  position: number;
}

export interface LTXStreamStopMessage {
  action: "stop";
  session_id: string;
}

export type LTXStreamMessage = LTXStreamStartMessage | LTXStreamStopMessage;

export interface LTXFHeader {
  media_type: string;
  sequence: number;
  is_init_segment?: boolean;
  final?: boolean;
}

export const LTXF_MAGIC = "LTXF" as const;

export const DEFAULTS = {
  aspectRatio: "16:9" as AspectRatio,
  videoWidth: 1920,
  videoHeight: 1088,
  numFrames: 49,
  frameRate: 24,
  loopyStrategy: "anchor_loop" as LoopyStrategy,
} as const;
