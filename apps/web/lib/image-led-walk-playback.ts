import sharp from "sharp";
import { CreatorError } from "./creator-error";
import type { ImageLedPlayback, ImageLedWalkDoc } from "./image-led-walk";

export function validateImageLedPlayback(value: ImageLedPlayback): ImageLedPlayback {
  if (!value || Object.keys(value).some(key => !["kind", "width", "height", "background"].includes(key)) || value.kind !== "contain-jpeg-v1" || value.background !== "#20231e" || ![value.width, value.height].every(n => Number.isInteger(n) && n >= 32 && n <= 4096)) throw new CreatorError("Quoted playback canvas changed", 409);
  return value;
}
/** All new views share the owner's exact starting canvas. Native masters stay untouched. */
export function imageLedPlayback(walk: ImageLedWalkDoc): ImageLedPlayback {
  const first = walk.frames[0]?.image ?? walk.seed?.image;
  return validateImageLedPlayback({ kind: "contain-jpeg-v1", width: first?.width ?? 688, height: first?.height ?? 387, background: "#20231e" });
}
export async function prepareImageLedPlayback(bytes: Buffer, canvas: ImageLedPlayback) {
  validateImageLedPlayback(canvas);
  return sharp(bytes).resize({ width: canvas.width, height: canvas.height, fit: "contain", position: "centre", background: canvas.background, withoutEnlargement: true }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}
