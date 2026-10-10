import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KLING_ENDPOINT_VIDEO_MODEL, validateKlingEndpointVideoCapability } from "./image-led-kling-video-capability";

const image = { bytes: 2_850_000, width: 1672, height: 941, content_type: "image/png" as const };
const body = { prompt: "One continuous forward walking shot between the exact supplied views.", duration: "5", generate_audio: false, shot_type: "customize",
  image_url: "data:image/png;base64,AAAA", end_image_url: "data:image/png;base64,BBBB" };
const valid = { model: KLING_ENDPOINT_VIDEO_MODEL, body, start: image, end: image };

describe("offline Kling endpoint capability", () => {
  it("accepts exact closed four/five-second schemas without rewriting their bodies", () => {
    const frozen = Object.freeze({ ...body }); validateKlingEndpointVideoCapability({ ...valid, body: frozen }); expect(frozen).toEqual(body);
    const four = Object.freeze({ ...body, duration: "4" }); validateKlingEndpointVideoCapability({ ...valid, body: four }); expect(four.duration).toBe("4");
  });
  it("rejects the actual flat-four-references plus end-frame cross-field failure", () => {
    expect(() => validateKlingEndpointVideoCapability({ ...valid, model: "fal-ai/kling-video/o3/standard/reference-to-video",
      body: { ...body, start_image_url: body.image_url, image_urls: ["ref1", "ref2", "ref3", "ref4"] } })).toThrow("Setting end image is not supported when there are more than 2 images");
  });
  const artifact = resolve(process.cwd(), "test-results/fantasy-fresh-rhWGis/video-pilots/reference-led-v4-execution-1791300166354/leg-p2-p3");
  it.skipIf(!existsSync(resolve(artifact, "request.json")))("reproduces the actual immutable failed request and provider 422 evidence", () => {
    const failed = JSON.parse(readFileSync(resolve(artifact, "request.json"), "utf8"));
    const error = JSON.parse(readFileSync(resolve(artifact, "get-result-body-1791300616669.txt"), "utf8"));
    expect(error.detail[0].type).toBe("value_error"); expect(error.detail[0].msg).toBe("Value error, Setting end image is not supported when there are more than 2 images.");
    expect(failed.image_urls).toHaveLength(4);
    expect(() => validateKlingEndpointVideoCapability({ ...valid, model: "fal-ai/kling-video/o3/standard/reference-to-video", body: failed })).toThrow("Known Fal 422");
  });
  it("refuses flat refs, element substitutions, unsupported fields and the wrong model mapping", () => {
    for (const extra of [{ image_urls: [] }, { elements: [] }, { aspect_ratio: "16:9" }, { start_image_url: body.image_url }, { multi_prompt: [] }, { seed: 42 }, { resolution: "768P" }])
      expect(() => validateKlingEndpointVideoCapability({ ...valid, body: { ...body, ...extra } })).toThrow("Unknown or missing");
    expect(() => validateKlingEndpointVideoCapability({ ...valid, model: "fal-ai/kling-video/v3/standard/image-to-video" })).toThrow("exact O3");
  });
  it("enforces actual file constraints rather than the frozen builder's old 32px floor", () => {
    for (const patch of [{ width: 299 }, { height: 299 }, { bytes: 50 * 1024 * 1024 + 1 }, { width: 900, height: 300 }, { width: 300, height: 900 }, { width: NaN }, { bytes: 0 }])
      expect(() => validateKlingEndpointVideoCapability({ ...valid, start: { ...image, ...patch } })).toThrow("documented");
    validateKlingEndpointVideoCapability({ ...valid, start: { ...image, width: 750, height: 300, bytes: 50 * 1024 * 1024 }, end: { ...image, width: 300, height: 750 } });
  });
  it("rejects changed shot/audio/duration, excessive prompts and invalid/identical endpoint inputs", () => {
    for (const patch of [{ duration: 5 }, { duration: "3" }, { duration: "6" }, { duration: "10" }, { generate_audio: true }, { shot_type: "intelligent" }, { prompt: " " }, { prompt: "x".repeat(2501) },
      { end_image_url: body.image_url }, { image_url: "file:///private/image.png" }, { image_url: "https://user:pass@example.com/input.png" }])
      expect(() => validateKlingEndpointVideoCapability({ ...valid, body: { ...body, ...patch } })).toThrow();
  });
});
