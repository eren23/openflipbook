// Stored mesh/illustration job and asset rows. A leaf module: the execution,
// input and view-store modules all read these shapes, so they live here to
// keep those modules free of import cycles.
import type { AssetKind } from "./asset-pipeline";
import type { MeshImportProvenance, MeshJob } from "./mesh-asset";
import type { MeshDimensions } from "./mesh-dimensions";
import type { MeshSourceDoc } from "./mesh-source";
import type { IllustrationEditInput, IllustrationGeometryRefresh, IllustrationRegionEdit } from "./place-view";

export interface ViewDependency { view_id: string; input_sha256: string; width: number; height: number }

export interface MeshJobDoc extends MeshJob {
  _id: string; session_id: string; created_at: Date;
  request_id?: string; parameters?: Record<string, unknown>; ledger_ids?: string[];
  submission_token?: string; submission_deadline?: Date; submission_started_at?: Date;
  work_token?: string; work_until?: Date; next_check?: Date;
  provider_result?: { status: "ready"; model_glb?: { url: string }; image?: { url: string }; seed?: number }; refresh_result?: boolean;
  download?: { key: string; sha256: string; bytes: number };
  view_dependency?: ViewDependency;
  edit_input?: IllustrationEditInput;
  image_input?: MeshSourceDoc;
  dependency?: { kind?: AssetKind; place_id: string; revision: number; input_sha256: string; build_key: string; result_sha256: string; plan_sha256: string; connections_sha256?: string };
}

export interface MeshAssetDoc { _id: string; id: string; session_id: string; key: string; sha256: string; bytes: number; model: string; prompt: string; request_id?: string; imported?: MeshImportProvenance; created_at: Date; content_type?: "image/jpeg" | "image/png"; region_edit?: IllustrationRegionEdit; edit_input?: IllustrationEditInput; geometry_refresh?: IllustrationGeometryRefresh; image_input?: MeshSourceDoc; parameters?: Record<string, unknown>; dependency?: MeshJobDoc["dependency"]; view_dependency?: ViewDependency; illustration?: { width: number; height: number; color_space: "srgb" }; geometry?: { sha256: string; size: MeshDimensions }; image?: { width: number; height: number; channel: "base_color"; color_space: "srgb"; tiling: "unverified" } }
