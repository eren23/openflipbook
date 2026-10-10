import { isDeepStrictEqual } from "node:util";
import { CreatorError } from "./creator-error";
import type { ImageLedImage, ImageLedRepair, ImageLedStillModel } from "./image-led-walk";

const version = "image-led-walk-v4";
/** Fixed provider schemas: unrecognized endpoints/parameters never reach uploads or spend. */
export const IMAGE_LED_STILL_PROFILES: Record<ImageLedStillModel, { parameters: Record<string, unknown>; max_references: number; mask: boolean }> = {
  "fal-ai/nano-banana-pro/edit": { parameters: { num_images: 1, output_format: "png", aspect_ratio: "16:9", resolution: "1K", seed: 42, safety_tolerance: "4", limit_generations: true, enable_web_search: false, sync_mode: false, prompt_version: version }, max_references: 14, mask: false },
  "openai/gpt-image-2.5/sunburst/edit": { parameters: { image_size: { width: 1536, height: 864 }, quality: "high", background: "opaque", num_images: 1, output_format: "png", sync_mode: false, prompt_version: version }, max_references: 16, mask: true },
  "blackforestlabs/flux-3/edit-image": { parameters: { aspect_ratio: "16:9", resolution: "1k", enable_prompt_expansion: false, safety_tolerance: 4, output_format: "png", sync_mode: false, prompt_version: version }, max_references: 10, mask: false },
  "bytedance/seedream/v5/pro/edit": { parameters: { image_size: { width: 1536, height: 864 }, num_images: 1, output_format: "png", enable_safety_checker: true, enhance_prompt_mode: "standard", sync_mode: false, prompt_version: version }, max_references: 10, mask: false },
};
export function imageLedStillProfile(model: unknown, parameters: unknown) {
  if (typeof model !== "string" || !Object.hasOwn(IMAGE_LED_STILL_PROFILES, model)) throw new CreatorError("Image-led still model is not allowlisted", 400);
  const profile = IMAGE_LED_STILL_PROFILES[model as ImageLedStillModel];
  if (!isDeepStrictEqual(parameters, profile.parameters)) throw new CreatorError("Image-led still provider parameters changed", 409);
  return { ...profile, model: model as ImageLedStillModel };
}
/** Ordered images are repair target, reviewed predecessor, map, then named crops. Masks are separate. */
export function validateImageLedStillInputs(model: unknown, parameters: unknown, images: readonly ImageLedImage[], repair?: ImageLedRepair) {
  const profile = imageLedStillProfile(model, parameters);
  if (!images.length || images.length > profile.max_references) throw new CreatorError("Still model reference limit exceeded; no references may be dropped", 400);
  if (repair?.mask && !profile.mask) throw new CreatorError("This still model does not support repair masks", 400);
  if (profile.model === "blackforestlabs/flux-3/edit-image" && images.some(image => Math.min(image.width, image.height) < 256 || image.width * image.height > 4_000_000)) throw new CreatorError("FLUX references must each be at least 256 pixels per side and at most 4 MP", 400);
  if ([...images, ...(repair?.mask ? [repair.mask] : [])].reduce((sum, image) => sum + image.bytes, 0) > 40 * 1024 * 1024) throw new CreatorError("Combined artwork references exceed 40 MiB", 413);
  return profile;
}
