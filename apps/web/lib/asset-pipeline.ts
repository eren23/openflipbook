import jpeg from "jpeg-js";
import { MAX_MESH_BYTES, MESH_MODEL, validateMeshGlb } from "./mesh-asset";

export type BuildAssetKind = "mesh" | "material";
export type AssetKind = BuildAssetKind | "illustration";
export interface AssetQuote { model: string; reservation: number; parameters: Record<string, unknown> }
export const ILLUSTRATION_MODEL = "fal-ai/flux-control-lora-depth/image-to-image";
export const ILLUSTRATION_EDIT_MODEL = "fal-ai/flux-general/inpainting";
export const KEYFRAME_MODEL = "fal-ai/qwen-image-edit-2511";
export const KEYFRAME_NANO_MODEL = "fal-ai/nano-banana-pro/edit";
export const KEYFRAME_FLUX_REFERENCE_MODEL = "fal-ai/flux-general/image-to-image";
export const isMapReferenceKeyframeModel = (model: unknown): model is typeof KEYFRAME_NANO_MODEL | typeof KEYFRAME_FLUX_REFERENCE_MODEL => model === KEYFRAME_NANO_MODEL || model === KEYFRAME_FLUX_REFERENCE_MODEL;
export const isKeyframeModel = (model: unknown): model is typeof KEYFRAME_MODEL | typeof KEYFRAME_NANO_MODEL | typeof KEYFRAME_FLUX_REFERENCE_MODEL => model === KEYFRAME_MODEL || isMapReferenceKeyframeModel(model);
function sameParameters(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => sameParameters(actual[i], value));
  if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => Object.hasOwn(a, key) && sameParameters(a[key], e[key]));
}
export function validFluxReferenceQuote(quote: AssetQuote) {
  if (quote.model !== KEYFRAME_FLUX_REFERENCE_MODEL) return true;
  const version = quote.parameters.prompt_version, balanced = version === "saved-camera-flux-reference-controlnet-v2";
  return Number.isFinite(quote.reservation) && quote.reservation >= .15 && quote.reservation <= 10
    && (balanced || version === "saved-camera-flux-reference-controlnet-v1") && sameParameters(quote.parameters, {
      num_images: 1, num_inference_steps: 28, guidance_scale: 3.5, seed: 42, strength: balanced ? .85 : .7,
      output_format: "jpeg", enable_safety_checker: true, sync_mode: false, use_real_cfg: false, ip_adapters: [], controlnets: [],
      controlnet_unions: [{ path: "Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro", controls: ["depth", "canny"].map((control_mode, i) => ({
        control_mode, conditioning_scale: balanced ? (i ? .4 : .2) : 1, start_percentage: 0, end_percentage: 1 })) }],
      reference_strength: .65, reference_start: 0, reference_end: 1, prompt_version: version, structural_guidance: "saved-camera-controlnet-v1",
      gate: { crop_pad: 1.6, centre_tolerance: .03, area_ratio: [.8, 1.2] },
    });
}
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
