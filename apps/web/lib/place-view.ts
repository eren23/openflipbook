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
}
export type RefreshPlaceView = (view: SavedPlaceView) => Promise<ViewCapture>;
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
