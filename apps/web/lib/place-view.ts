import type { PlaceSceneDefinition } from "@openflipbook/config";
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
// depth. The gate measures one building.
export interface IllustrationKeyframeInput {
  stage: "first" | "chain"; art?: "art" | "words";
  reference?: { key: string; sha256: string };
  chain_from?: { view_id: string; illustration_id: string; sha256: string };
  gate_object_id: string | null;
}
export interface IllustrationKeyframeCandidate {
  iou: number | null; centre_dx: number | null; centre_dy: number | null; area_ratio: number | null;
  painted: number | null; passed: boolean;
  // Chains only: mean RGB difference (0-255) from A's warp where A was trusted; lower wins among equals.
  agreement?: number | null;
}
export interface IllustrationKeyframe extends Omit<IllustrationKeyframeInput, "chain_from" | "gate_object_id"> {
  version: 1;
  // composite_share: the fraction of the stored picture that came from the candidate (absent on older chains).
  // objects: how many visible objects came whole from A, from the candidate, or count as ground (absent on older chains).
  chain_from?: NonNullable<IllustrationKeyframeInput["chain_from"]> & { angle: number; hole_share: number; composite_share?: number; objects?: { a: number; candidate: number; ground: number } };
  object_id: string | null;
  gate: "passed" | "failed" | "unmeasured";
  candidates: IllustrationKeyframeCandidate[]; chosen: number; passed: boolean; sky_pinned: boolean;
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
