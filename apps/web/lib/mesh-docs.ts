// Stored mesh/illustration job and asset rows. A leaf module: the execution,
// input and view-store modules all read these shapes, so they live here to
// keep those modules free of import cycles.
import type { AssetKind } from "./asset-pipeline";
import type { MeshImportProvenance, MeshJob } from "./mesh-asset";
import type { MeshDimensions } from "./mesh-dimensions";
import type { MeshSourceDoc } from "./mesh-source";
import type { IllustrationEditInput, IllustrationGeometryRefresh, IllustrationKeyframe, IllustrationKeyframeInput, IllustrationRegionEdit } from "./place-view";

export interface ViewDependency { view_id: string; input_sha256: string; width: number; height: number }
// "started" is saved before the gate call; finding it later means the call
// was interrupted, which counts as an outage so SAM-3 never runs twice.
// "no_building" (the name is older): the keyframe has no gate subject.
export type KeyframeGateDoc = { status: "measured"; masks: (string | null)[] } | { status: "started" | "outage" | "no_building" };

export interface MeshJobDoc extends MeshJob {
  _id: string; session_id: string; created_at: Date;
  request_id?: string; parameters?: Record<string, unknown>; ledger_ids?: string[];
  submission_token?: string; submission_deadline?: Date; submission_started_at?: Date;
  work_token?: string; work_until?: Date; next_check?: Date;
  provider_result?: { status: "ready"; model_glb?: { url: string }; image?: { url: string }; images?: { url: string }[]; seed?: number }; refresh_result?: boolean;
  download?: { key: string; sha256: string; bytes: number };
  view_dependency?: ViewDependency;
  edit_input?: IllustrationEditInput;
  keyframe_input?: IllustrationKeyframeInput; keyframe_gate?: KeyframeGateDoc; keyframe_result?: IllustrationKeyframe;
  image_input?: MeshSourceDoc;
  dependency?: { kind?: AssetKind; place_id: string; revision: number; input_sha256: string; build_key: string; result_sha256: string; plan_sha256: string; connections_sha256?: string };
}

export interface MeshAssetDoc { _id: string; id: string; session_id: string; key: string; sha256: string; bytes: number; model: string; prompt: string; request_id?: string; imported?: MeshImportProvenance; created_at: Date; content_type?: "image/jpeg" | "image/png"; region_edit?: IllustrationRegionEdit; edit_input?: IllustrationEditInput; geometry_refresh?: IllustrationGeometryRefresh; keyframe?: IllustrationKeyframe; image_input?: MeshSourceDoc; parameters?: Record<string, unknown>; dependency?: MeshJobDoc["dependency"]; view_dependency?: ViewDependency; illustration?: { width: number; height: number; color_space: "srgb" }; geometry?: { sha256: string; size: MeshDimensions }; image?: { width: number; height: number; channel: "base_color"; color_space: "srgb"; tiling: "unverified" } }
