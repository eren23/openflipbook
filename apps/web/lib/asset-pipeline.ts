import jpeg from "jpeg-js";
import { MAX_MESH_BYTES, MESH_MODEL, validateMeshGlb } from "./mesh-asset";

export type BuildAssetKind = "mesh" | "material";
export type AssetKind = BuildAssetKind | "illustration";
export interface AssetQuote { model: string; reservation: number; parameters: Record<string, unknown> }
export const ILLUSTRATION_MODEL = "fal-ai/flux-control-lora-depth/image-to-image";
export const ILLUSTRATION_EDIT_MODEL = "fal-ai/flux-general/inpainting";
export const MATERIAL_MODEL = "bytedance/seedream/v5/pro/text-to-image";
export const MATERIAL_MAX_BYTES = 12 * 1024 * 1024;
export const assetPipeline = (kind: AssetKind) => kind === "mesh"
  ? { kind, model: MESH_MODEL, extension: "glb", contentType: "model/gltf-binary", maxBytes: MAX_MESH_BYTES, cap: "MESH_DAILY_CAP_USD" }
  : kind === "material" ? { kind, model: MATERIAL_MODEL, extension: "jpg", contentType: "image/jpeg", maxBytes: MATERIAL_MAX_BYTES, cap: "MATERIAL_DAILY_CAP_USD" }
  : { kind, model: ILLUSTRATION_MODEL, extension: "jpg", contentType: "image/jpeg", maxBytes: MATERIAL_MAX_BYTES, cap: "ILLUSTRATION_DAILY_CAP_USD" };

export function validateAssetBytes(kind: AssetKind, bytes: Uint8Array) {
  if (kind === "mesh") { validateMeshGlb(bytes); return {}; }
  if (bytes.length > MATERIAL_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Expected a JPEG material within 12 MiB");
  const decoded = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 4.2, maxMemoryUsageInMB: 128 });
  if (kind === "illustration") {
    if (decoded.width < 32 || decoded.height < 32 || decoded.width > 1024 || decoded.height > 1024) throw new Error("Illustration dimensions must be within the saved camera limit");
    return { illustration: { width: decoded.width, height: decoded.height, color_space: "srgb" as const } };
  }
  if (decoded.width !== decoded.height || decoded.width < 256 || decoded.width > 2048) throw new Error("Material must be a square texture from 256 to 2048 pixels");
  return { image: { width: decoded.width, height: decoded.height, channel: "base_color" as const, color_space: "srgb" as const, tiling: "unverified" as const } };
}
