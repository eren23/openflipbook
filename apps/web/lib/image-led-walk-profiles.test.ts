// @vitest-environment node
import { expect, it } from "vitest";
import type { ImageLedImage, ImageLedRepair } from "./image-led-walk";
import { IMAGE_LED_STILL_PROFILES, imageLedStillProfile, validateImageLedStillInputs } from "./image-led-walk-profiles";
const image: ImageLedImage = { key: "world/image-led/raw.png", sha256: "a".repeat(64), bytes: 128, width: 512, height: 288, content_type: "image/png" };
it.each(Object.keys(IMAGE_LED_STILL_PROFILES))("refuses extra provider fields for %s", model => {
  const parameters = IMAGE_LED_STILL_PROFILES[model as keyof typeof IMAGE_LED_STILL_PROFILES].parameters;
  expect(() => imageLedStillProfile(model, { ...parameters, mask_url: "https://foreign.test/mask.png" })).toThrow("parameters changed");
  expect(() => imageLedStillProfile(model, { ...parameters, output_format: "jpeg" })).toThrow("parameters changed");
});
it.each(["https://untrusted.test/edit", "fal-ai/not-approved/edit", "__proto__", "constructor"])("does not admit arbitrary %s endpoints", model => {
  expect(() => imageLedStillProfile(model, {})).toThrow("not allowlisted");
});
it.each(["blackforestlabs/flux-3/edit-image", "bytedance/seedream/v5/pro/edit"] as const)("rejects %s actual reference overflow without truncating the ordered list", model => {
  const inputs = Array.from({ length: 11 }, () => image), before = [...inputs];
  expect(() => validateImageLedStillInputs(model, IMAGE_LED_STILL_PROFILES[model].parameters, inputs)).toThrow("no references may be dropped"); expect(inputs).toEqual(before);
});
it.each([{ width: 255, height: 256 }, { width: 256, height: 255 }, { width: 2001, height: 2000 }])("rejects FLUX invalid input size %o before provider work", dimensions => {
  const model = "blackforestlabs/flux-3/edit-image";
  expect(() => validateImageLedStillInputs(model, IMAGE_LED_STILL_PROFILES[model].parameters, [{ ...image, ...dimensions }])).toThrow("at least 256");
});
it("does not confuse FLUX lowercase resolution and integer safety tolerance with NanoPro", () => {
  const model = "blackforestlabs/flux-3/edit-image", parameters = IMAGE_LED_STILL_PROFILES[model].parameters;
  expect(() => imageLedStillProfile(model, { ...parameters, resolution: "1K" })).toThrow();
  expect(() => imageLedStillProfile(model, { ...parameters, safety_tolerance: "4" })).toThrow();
  expect(() => imageLedStillProfile(model, { ...parameters, num_images: 1 })).toThrow();
});
it("only Sunburst admits a separately hash-bound mask", () => {
  const repair: ImageLedRepair = { checkpoint_index: 0, source_sha256: "b".repeat(64), target_sha256: image.sha256, image, mask: { ...image, key: "world/image-led/mask.png" } };
  for (const [model, profile] of Object.entries(IMAGE_LED_STILL_PROFILES)) {
    if (model === "openai/gpt-image-2.5/sunburst/edit") expect(validateImageLedStillInputs(model, profile.parameters, [image], repair).mask).toBe(true);
    else expect(() => validateImageLedStillInputs(model, profile.parameters, [image], repair)).toThrow("does not support");
  }
});
