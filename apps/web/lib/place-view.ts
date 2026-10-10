import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import type { CameraPathDraft } from "./camera-path";
import type { IllustrationBrushStroke } from "./illustration-brush";

export const VIEW_PASSES = ["render", "depth", "normals", "objects"] as const;
export type ViewPass = typeof VIEW_PASSES[number];
export interface ViewCamera {
  projection: "perspective" | "orthographic";
  world_matrix: number[]; projection_matrix: number[];
  near: number; far: number;
}
export interface ViewSource {
  scene_id: string; place_id: string; revision: number;
  x: number; z: number; definition: PlaceSceneDefinition;
}
export interface ViewCapture {
  version: 1; mode: "plan" | "orbit" | "walk";
  width: number; height: number; camera: ViewCamera;
  floor_id: string | null;
  depth: { encoding: "linear_view_z_8bit_near_white"; near: number; far: number };
  normals: "view_space_rgb";
  surface_policy: "opaque_geometry";
  objects: { object_id: string; rgb: [number, number, number] }[];
  sources: ViewSource[];
  passes: Record<ViewPass, string>;
  path?: CameraPathDraft;
}
export type SavedViewSource = Omit<ViewSource, "definition"> & { definition_sha256: string };
export interface SavedPlaceView extends Omit<ViewCapture, "passes" | "sources"> {
  id: string; label: string; created_at: string; root_place_id: string;
  sources: SavedViewSource[];
  assets: { kind: "mesh" | "material"; id: string; sha256: string }[];
  historical: boolean;
  provenance: "client_rendered_saved_geometry";
  accepted_illustration_id?: string;
  refreshed_from?: string;
  // Immutable capture intent: a complete exterior map rendered from its saved camera.
  purpose?: "map";
  // Saved by "Make walk video": outside the 50-view limit, the library list and export.
  walk_checkpoint?: true;
}
export type RefreshPlaceView = (view: SavedPlaceView) => Promise<ViewCapture>;
// The live viewport's capture. In the Walk view, `pose` captures that eye pose instead (walk-route WalkCheckpoint).
export type CapturePlaceView = (pose?: { x: number; z: number; yaw: number }) => ViewCapture;
export interface PlaceViewExport {
  view: SavedPlaceView;
  capture_metadata?: Record<string, unknown>;
  passes: { pass: ViewPass; sha256: string; bytes: Uint8Array }[];
  illustrations?: { asset: SavedIllustration; bytes: Uint8Array }[];
}
export interface SavedIllustration {
  id: string; prompt: string; model: string; sha256: string; request_id: string;
  created_at: string; parameters: Record<string, unknown>;
  view_dependency: { view_id: string; input_sha256: string; width: number; height: number };
  accepted: boolean; historical: boolean;
  content_type?: "image/jpeg" | "image/png";
  region_edit?: IllustrationRegionEdit;
  edit_input?: IllustrationEditInput;
  geometry_refresh?: IllustrationGeometryRefresh;
  keyframe?: IllustrationKeyframe;
}
// A keyframe request: the exact render, painted from the art or words. A chain
// also composites an accepted keyframe at another camera over it, warped by
// depth. The gate measures one object: a building when one is large enough.
export interface IllustrationKeyframeInput {
  stage: "first" | "chain"; art?: "art" | "words";
  reference_profile?: "source-art-map-landmarks-v1";
  reference_guidance?: "saved-camera-guides-v1" | "saved-camera-controlnet-v1";
  reference?: { key: string; sha256: string };
  reference_preparation?: KeyframeReferencePreparation;
  chain_from?: { view_id: string; illustration_id: string; sha256: string };
  gate_object_id: string | null;
  // The gated object and the word SAM-3 is prompted with; null when nothing is
  // large enough (the paint check alone decides). Absent on older jobs: a building.
  gate_subject?: KeyframeGateSubject | null;
}
/** Exact source pixels rearranged into layout-neutral material samples. */
export interface KeyframeReferencePreparation {
  version: "source-art-material-crops-v1" | "source-art-map-landmarks-v1"; source_sha256: string; sha256: string;
  source_width: number; source_height: number; width: number; height: number; tile_size: number; gutter: number;
  crops: { left: number; top: number; width: number; height: number; x: number; y: number }[];
  structural_guidance?: KeyframeStructuralGuideProof;
  landmarks?: (SourceArtworkLandmark & { sha256: string; output_width: number; output_height: number })[];
}
export interface KeyframeStructuralGuideProof {
  version: "saved-camera-guides-v1" | "saved-camera-controlnet-v1"; width: 688; height: 384;
  outline_sha256?: string;
  guide_sha256: string; render_sha256: string; objects_sha256: string; depth_sha256: string;
  landmarks: { index: number; label: string; object_id: string; visible_pixels: number }[];
}
export interface SourceArtworkLandmark { label: string; left: number; top: number; width: number; height: number }
export interface KeyframeProviderOutput {
  version: "nano-1k-half-size-v1"; raw_sha256: string; raw_width: 1376; raw_height: 768;
  raw_content_type: "image/png"; output_sha256: string; output_width: 688; output_height: 384; scale: .5; crop: false;
  raw_key?: string; raw_bytes?: number;
}
export interface KeyframeGateSubject { object_id: string; kind: PlaceSceneObject["kind"]; label: string }
export interface IllustrationKeyframeCandidate {
  iou: number | null; centre_dx: number | null; centre_dy: number | null; area_ratio: number | null;
  painted: number | null; passed: boolean;
  // Chains only: mean RGB difference (0-255) from A's warp where A was trusted; lower wins among equals.
  agreement?: number | null;
}
/** Offline checks on the exact stored image; the camera gate measures the raw candidate. */
export interface KeyframeFinalImage {
  version: 1; sha256: string; candidate_sha256: string; width: number; height: number;
  method: "candidate" | "depth_warp_v1";
  invariants: { dimensions: boolean; opaque: boolean; composition: boolean; protected_pixels: number; changed_protected_pixels: number };
}
export interface IllustrationKeyframe extends Omit<IllustrationKeyframeInput, "chain_from" | "gate_object_id"> {
  version: 1;
  provider_outputs?: KeyframeProviderOutput[];
  // composite_share: the fraction of the stored picture that came from the candidate (absent on older chains).
  // objects: how many visible objects came whole from A, from the candidate, or count as ground (absent on older chains).
  chain_from?: NonNullable<IllustrationKeyframeInput["chain_from"]> & { angle: number; hole_share: number; composite_share?: number; objects?: { a: number; candidate: number; ground: number } };
  object_id: string | null;
  gate: "passed" | "failed" | "unmeasured";
  candidates: IllustrationKeyframeCandidate[]; chosen: number; passed: boolean; sky_pinned: boolean;
  final_image?: KeyframeFinalImage;
  // A human review of the final bytes, independent of the silhouette/paint measurement.
  content_approval?: { version: 1; method: "owner_review"; sha256: string; reviewed_at: string };
}
export interface IllustrationGeometryRefresh {
  version: 1; method: "registered_render_delta_rgba_v1"; padding_px: 2;
  request_sha256: string; proposal_id: string; proposal_sha256: string;
  base_view: SavedIllustration["view_dependency"];
  base_id: string | null; base_sha256: string; previous_id: string | null;
  mask_sha256: string; changed_pixels: number; protected_pixels: number;
}
export interface IllustrationEditInput {
  base_id: string | null; base_sha256: string; mask_sha256: string;
  object_ids: string[];
  brush_strokes?: IllustrationBrushStroke[];
}
export interface IllustrationRegionEdit {
  version: 1; request_sha256: string;
  proposal_id: string; proposal_sha256: string;
  base_id: string | null; base_sha256: string;
  object_ids: string[]; mask_sha256: string;
  brush_strokes?: IllustrationBrushStroke[];
  selected_pixels: number; protected_pixels: number;
  method: "exact_object_mask_rgba_v1" | "object_clipped_brush_rgba_v1";
}
export const objectMaskColor = (index: number): [number, number, number] => {
  const code = (index + 1) * 104729;
  return [(code >> 16) & 255, (code >> 8) & 255, code & 255];
};
