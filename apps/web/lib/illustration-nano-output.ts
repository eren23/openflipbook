import sharp from "sharp";
import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";
import type { KeyframeProviderOutput } from "./place-view";

/** One declared uniform half-size conversion. Never crop or stretch a provider result. */
export async function normalizeNanoKeyframe(raw: Buffer, view: { width: number; height: number }) {
  if (view.width !== 688 || view.height !== 384) throw new CreatorError("Nano keyframes need a compatible 688 × 384 saved camera.", 409);
  const metadata = await sharp(raw, { limitInputPixels: 2 * 1024 * 1024, failOn: "error" }).metadata();
  if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1 || metadata.width !== 1376 || metadata.height !== 768 || metadata.orientation && metadata.orientation !== 1)
    throw new CreatorError("The provider image has an incompatible size or format. Keep the raw output for review; no crop or stretch is allowed.", 409);
  const bytes = await sharp(raw, { limitInputPixels: 2 * 1024 * 1024, failOn: "error" })
    .flatten({ background: "#ffffff" }).toColourspace("srgb")
    .resize(688, 384, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const result = await sharp(bytes).metadata();
  if (result.width !== 688 || result.height !== 384) throw new CreatorError("Uniform keyframe conversion failed.", 409);
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const normalization: KeyframeProviderOutput = { version: "nano-1k-half-size-v1", raw_sha256: hash(raw), raw_width: 1376, raw_height: 768,
    raw_content_type: "image/png", output_sha256: hash(bytes), output_width: 688, output_height: 384, scale: .5, crop: false };
  return { bytes, normalization };
}
