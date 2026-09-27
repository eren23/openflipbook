import { createHash } from "node:crypto";
import sharp from "sharp";
import { CreatorError } from "./creator-error";
import type { ViewCapture } from "./place-view";
import { brushPixels, type IllustrationBrushStroke } from "./illustration-brush";

export const pixelBytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function registeredPixels(bytes: Buffer, width: number, height: number, pngOnly = false) {
  if (bytes.length > 12 * 1024 * 1024 || !Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || width > 1024 || height > 1024) throw new CreatorError("Invalid registered image dimensions or size", 400);
  try {
    const image = sharp(bytes, { limitInputPixels: 1024 * 1024, failOn: "warning" }), info = await image.metadata();
    // Browsers honor EXIF transforms; copying the untransformed pixels would
    // apply a correctly sized mask to a differently oriented visible image.
    if (info.orientation !== undefined && info.orientation !== 1) throw new Error("Image orientation differs from the saved camera");
    if (info.width !== width || info.height !== height || (info.pages ?? 1) !== 1 || !["png", ...(pngOnly ? [] : ["jpeg"])].includes(info.format ?? "")) throw new Error("Image differs from the camera registration");
    return await image.toColourspace("srgb").ensureAlpha().raw().toBuffer();
  } catch { throw new CreatorError("Saved image must decode at the registered camera dimensions", 400); }
}

export function selectedObjectIds(raw: unknown, objects: ViewCapture["objects"]) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 128 || raw.some(id => typeof id !== "string" || !objects.some(o => o.object_id === id)) || new Set(raw).size !== raw.length) throw new CreatorError("Select 1 to 128 distinct objects from this saved camera", 400);
  return [...raw].sort() as string[];
}

export async function composeRegisteredObjects(base: Buffer, proposal: Buffer, mask: Buffer, view: Pick<ViewCapture, "width" | "height" | "objects">, ids: string[], strokes?: IllustrationBrushStroke[]) {
  const { width, height } = view;
  const output = await registeredPixels(base, width, height), source = await registeredPixels(proposal, width, height);
  const selection = await registeredObjectMask(mask, view, ids, strokes);
  // No feathering, resizing or JPEG re-encoding: every unselected RGBA pixel is
  // copied exactly from the decoded base, including background and occluders.
  for (let p = 0; p < selection.data.length; p++) if (selection.data[p]) source.copy(output, p * 4, p * 4, p * 4 + 4);
  return { bytes: await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer(), selected_pixels: selection.selected_pixels, protected_pixels: selection.protected_pixels };
}

export async function registeredObjectMask(mask: Buffer, view: Pick<ViewCapture, "width" | "height" | "objects">, ids: string[], strokes?: IllustrationBrushStroke[]) {
  const selected = selectedObjectIds(ids, view.objects), { width, height } = view;
  const labels = await registeredPixels(mask, width, height, true), data = Buffer.alloc(width * height);
  const colors = new Map(view.objects.filter(o => selected.includes(o.object_id)).map(o => [o.rgb[0] * 65536 + o.rgb[1] * 256 + o.rgb[2], o.object_id]));
  const seen = new Set<string>(); let count = 0;
  const brush = strokes ? brushPixels(strokes, width, height) : null;
  for (let i = 0; i < labels.length; i += 4) {
    const id = colors.get(labels[i]! * 65536 + labels[i + 1]! * 256 + labels[i + 2]!);
    if (id && labels[i + 3] === 255 && (!brush || brush[i / 4])) { data[i / 4] = 255; seen.add(id); count++; }
  }
  if (seen.size !== selected.length) throw new CreatorError("A selected object has no visible pixels in this capture", 409);
  if (count === width * height) throw new CreatorError("Region edits must leave protected pixels outside the selection", 400);
  return { data, bytes: await sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer(), selected_pixels: count, protected_pixels: width * height - count };
}
