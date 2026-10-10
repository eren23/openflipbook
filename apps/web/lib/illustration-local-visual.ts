/** Server-derived visual prompts. They measure the candidate; they never trim its mask. */
import { createHash } from "node:crypto";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import { CreatorError } from "./creator-error";
import { registeredPixels } from "./illustration-region";
import type { ViewCapture } from "./place-view";

export const LOCAL_VISUAL_SEGMENTATION_PROFILE = "sam3-visual-full-frame-v1";
export type LocalSegmentationProfile = typeof LOCAL_VISUAL_SEGMENTATION_PROFILE;
const WIDTH = 688, HEIGHT = 384, MARGIN = 8;
type RGB = [number, number, number];
type Point = { x: number; y: number; label: 0 | 1; object_id: 1 };
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const colorKey = (rgb: RGB) => rgb[0] * 65536 + rgb[1] * 256 + rgb[2];

type VisualView = Pick<ViewCapture, "width" | "height" | "objects">;
function rgbFor(view: VisualView, id: string): RGB {
  const entries = view.objects.filter(entry => entry.object_id === id), rgb = entries[0]?.rgb;
  if (entries.length !== 1 || !Array.isArray(rgb) || rgb.length !== 3 || rgb.some(n => !Number.isInteger(n) || n < 0 || n > 255) || colorKey(rgb) === 0
    || view.objects.some(entry => entry.object_id !== id && colorKey(entry.rgb) === colorKey(rgb))) throw new CreatorError("Saved visual object identifier is invalid", 409);
  return rgb;
}

function interior(mask: Uint8Array) {
  // An integral image gives exactly the same 17 × 17 erosion as the pinned
  // segmenter. The frame's eight-pixel border is always excluded.
  const stride = WIDTH + 1, sums = new Uint32Array(stride * (HEIGHT + 1)), safe = new Uint8Array(mask.length);
  for (let y = 0; y < HEIGHT; y++) { let row = 0; for (let x = 0; x < WIDTH; x++) { row += mask[y * WIDTH + x]!; sums[(y + 1) * stride + x + 1] = row + sums[y * stride + x + 1]!; } }
  const side = MARGIN * 2 + 1;
  for (let y = MARGIN; y < HEIGHT - MARGIN; y++) for (let x = MARGIN; x < WIDTH - MARGIN; x++) {
    const x0 = x - MARGIN, x1 = x + MARGIN + 1, y0 = y - MARGIN, y1 = y + MARGIN + 1;
    if (sums[y1 * stride + x1]! - sums[y0 * stride + x1]! - sums[y1 * stride + x0]! + sums[y0 * stride + x0]! === side * side) safe[y * WIDTH + x] = 1;
  }
  return safe;
}
function point(mask: Uint8Array, y0: number, y1: number): [number, number] | null {
  let count = 0, sx = 0, sy = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < WIDTH; x++) if (mask[y * WIDTH + x]) { count++; sx += x; sy += y; }
  if (!count) return null;
  const n = BigInt(count), sumX = BigInt(sx), sumY = BigInt(sy); let best: bigint | null = null, result: [number, number] | null = null;
  // Integer distances preserve the Python segmenter's exact centroid/tie rule.
  for (let y = y0; y < y1; y++) for (let x = 0; x < WIDTH; x++) if (mask[y * WIDTH + x]) {
    const dx = BigInt(x) * n - sumX, dy = BigInt(y) * n - sumY, distance = dx * dx + dy * dy;
    if (best === null || distance < best) { best = distance; result = [x, y]; }
  }
  return result;
}

export async function localVisualGeometry(view: VisualView, definition: PlaceSceneDefinition, labels: string[], subjectId: string, objects: Buffer, jpeg: Buffer, box: number[]) {
  if (view.width !== WIDTH || view.height !== HEIGHT || objects.length > 2 * 1024 * 1024 || jpeg.length > 4 * 1024 * 1024) throw new CreatorError("Visual measurement requires the bounded registered camera files", 409);
  if (labels.length !== 4 || new Set(labels).size !== 4) throw new CreatorError("Visual measurement requires four source building identities", 409);
  const buildings = labels.map(label => {
    const matches = definition.objects.filter(o => o.label === label && ["building", "house", "tavern"].includes(o.kind));
    if (matches.length !== 1) throw new CreatorError("Source building identity is ambiguous", 409);
    return matches[0]!;
  });
  if (new Set(buildings.map(o => o.id)).size !== 4 || !buildings.some(o => o.id === subjectId)) throw new CreatorError("Visual subject must be one of the four source buildings", 409);
  const subject = rgbFor(view, subjectId), others = buildings.filter(o => o.id !== subjectId).map(o => rgbFor(view, o.id));
  const pixels = await registeredPixels(objects, WIDTH, HEIGHT, true), codes = new Uint32Array(WIDTH * HEIGHT);
  for (let p = 0; p < codes.length; p++) {
    if (pixels[p * 4 + 3] !== 255) throw new CreatorError("Visual object pass must be opaque", 409);
    codes[p] = pixels[p * 4]! * 65536 + pixels[p * 4 + 1]! * 256 + pixels[p * 4 + 2]!;
  }
  const roadCandidates = definition.objects.filter(o => o.kind === "path").map(o => ({ id: o.id, rgb: rgbFor(view, o.id) })).filter(o => {
    const code = colorKey(o.rgb); return codes.subarray(Math.ceil(HEIGHT * .8) * WIDTH).includes(code);
  });
  if (roadCandidates.length !== 1) throw new CreatorError("Saved camera needs one unambiguous visible road path", 409);
  const road = roadCandidates[0]!.rgb, colors = [subject, ...others, road], keys = colors.map(colorKey);
  if (new Set(keys).size !== 5) throw new CreatorError("Visual building and road identifiers must be distinct", 409);
  const masks = keys.map(key => Uint8Array.from(codes, code => code === key ? 1 : 0));
  let x0 = WIDTH, y0 = HEIGHT, x1 = 0, y1 = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (masks[0]![y * WIDTH + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  if (JSON.stringify(box) !== JSON.stringify([x0, y0, x1, y1]) || x0 >= x1 || y0 >= y1) throw new CreatorError("Visual subject box differs from its saved pixels", 409);
  const subjectInterior = interior(masks[0]!), middle = Math.floor((y0 + y1) / 2), points: Point[] = [];
  for (const p of [point(subjectInterior, y0, middle), point(subjectInterior, middle, y1)]) if (p) points.push({ x: p[0], y: p[1], label: 1, object_id: 1 });
  if (!points.length) throw new CreatorError("Saved visual subject has no safe interior point", 409);
  for (const mask of masks.slice(1, 4)) { const p = point(interior(mask), 0, HEIGHT); if (p) points.push({ x: p[0], y: p[1], label: 0, object_id: 1 }); }
  const roadPoint = point(interior(masks[4]!), Math.ceil(HEIGHT * .8), HEIGHT);
  if (roadPoint) points.push({ x: roadPoint[0], y: roadPoint[1], label: 0, object_id: 1 });
  const geometry = { objects_data_url: `data:image/png;base64,${objects.toString("base64")}`, subject_rgb: subject, other_building_rgbs: others, road_rgb: road };
  const proof = { version: LOCAL_VISUAL_SEGMENTATION_PROFILE, objects_sha256: sha(objects), width: WIDTH, height: HEIGHT, subject_rgb: subject, other_building_rgbs: others, road_rgb: road, point_margin: MARGIN,
    image_sha256: sha(jpeg), box_prompts: [{ x_min: x0, y_min: y0, x_max: x1, y_max: y1, object_id: 1 }], point_prompts: points };
  return { geometry, proof };
}
