/** Offline schema preflight only. It grants no spend, owner review, or visual-quality clearance. */
export const KLING_ENDPOINT_VIDEO_MODEL = "fal-ai/kling-video/o3/standard/image-to-video";
export const KLING_ENDPOINT_VIDEO_SCHEMA_URL = "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fkling-video%2Fo3%2Fstandard%2Fimage-to-video";
export const KLING_ENDPOINT_VIDEO_DOCS_URL = "https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video/api";
export type KlingEndpointVideoDuration = "4" | "5";

export interface KlingEndpointCapabilityImage {
  bytes: number;
  width: number;
  height: number;
  content_type: "image/png" | "image/jpeg";
}

const fail = (message: string): never => { throw new RangeError(message); };
function imageBounds(image: KlingEndpointCapabilityImage) {
  if (!image || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > 50 * 1024 * 1024
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 300 || image.height < 300
    || image.width / image.height < .4 || image.width / image.height > 2.5
    || !["image/png", "image/jpeg"].includes(image.content_type)) fail("Endpoint image exceeds documented encoding, 300px, aspect, or 50MiB bounds");
}
function fileInput(value: unknown): value is string {
  if (typeof value !== "string" || !value.length) return false;
  if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

/**
 * Closed four/five-second endpoint-only profiles derived from the live GET OpenAPI.
 * The caller must separately decode and pin the actual bytes behind these metadata and URLs.
 * O3 reference-to-video's displayed schema omits its runtime end+many-images validator;
 * merely listing end/elements fields is not proof that their combination is accepted.
 */
export function validateKlingEndpointVideoCapability(input: {
  model: string;
  body: unknown;
  start: KlingEndpointCapabilityImage;
  end: KlingEndpointCapabilityImage;
}): void {
  const { body } = input;
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("A closed endpoint request object is required");
  const value = body as Record<string, unknown>;
  // The actual saved pilot failed before producing a video with this precise cross-field condition.
  if (value.end_image_url && Array.isArray(value.image_urls) && value.image_urls.length > 2)
    fail("Known Fal 422: Setting end image is not supported when there are more than 2 images.");
  if (input.model !== KLING_ENDPOINT_VIDEO_MODEL) fail("This capability validates only the exact O3 Standard endpoint-only model");
  const expected = ["duration", "end_image_url", "generate_audio", "image_url", "prompt", "shot_type"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) fail("Unknown or missing endpoint-only provider fields");
  if (!["4", "5"].includes(value.duration as string) || value.generate_audio !== false || value.shot_type !== "customize") fail("The closed profile requires four or five seconds, audio off, and customize shot mode");
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 2500) fail("A nonempty prompt of at most 2500 characters is required");
  if (!fileInput(value.image_url) || !fileInput(value.end_image_url) || value.image_url === value.end_image_url) fail("Two distinct endpoint file inputs are required");
  imageBounds(input.start); imageBounds(input.end);
}
