import { clamp01 } from "./clamp";
import { objectContainRect, type ContainRect } from "./image-click";

/** A drag-selected edit region, normalized 0..1 in natural-image space —
 *  the same convention as `cropBox` / entity bboxes. Mirrors `edit_region`
 *  on the wire (packages/config GenerateRequestBody). */
export interface EditRegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Below this fraction per axis a "drag" is just a click — no selection. */
const MIN_DRAG_FRAC = 0.02;

/**
 * Convert a drag (element-relative pixel start/end) into a normalized
 * natural-image region, handling object-fit: contain letterboxing — points
 * in the letterbox margins clamp onto the content edge. Returns null for
 * degenerate drags (a click) or when dimensions are unknown.
 */
export function dragToRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  boxWidth: number,
  boxHeight: number,
  naturalWidth: number,
  naturalHeight: number
): EditRegionBox | null {
  const content = objectContainRect(
    boxWidth,
    boxHeight,
    naturalWidth,
    naturalHeight
  );
  if (!content) return null;
  const nx = (px: number) => clamp01((px - content.offsetX) / content.width);
  const ny = (py: number) => clamp01((py - content.offsetY) / content.height);
  const x0 = Math.min(nx(start.x), nx(end.x));
  const y0 = Math.min(ny(start.y), ny(end.y));
  const w = Math.max(nx(start.x), nx(end.x)) - x0;
  const h = Math.max(ny(start.y), ny(end.y)) - y0;
  if (w < MIN_DRAG_FRAC || h < MIN_DRAG_FRAC) return null;
  return { x: x0, y: y0, w, h };
}

/** Natural-pixel rect of a region (for canvas drawing), rounded + clamped. */
export function regionToPixelRect(
  box: EditRegionBox,
  naturalWidth: number,
  naturalHeight: number
): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.max(0, Math.round(box.x * naturalWidth));
  const sy = Math.max(0, Math.round(box.y * naturalHeight));
  const sw = Math.min(naturalWidth - sx, Math.round(box.w * naturalWidth));
  const sh = Math.min(naturalHeight - sy, Math.round(box.h * naturalHeight));
  return { sx, sy, sw: Math.max(1, sw), sh: Math.max(1, sh) };
}

/** Display-pixel rect of a region on the letterboxed content (for overlays). */
export function regionToDisplayRect(
  box: EditRegionBox,
  content: ContainRect
): { left: number; top: number; width: number; height: number } {
  return {
    left: content.offsetX + box.x * content.width,
    top: content.offsetY + box.y * content.height,
    width: box.w * content.width,
    height: box.h * content.height,
  };
}

/**
 * Build the wire mask: an opaque PNG at the image's NATURAL dims, white =
 * edit / black = keep (flux fill's native convention — the backend adapts
 * if its model ever changes). Lossless PNG; a JPEG mask would blur the edge.
 */
export async function buildMaskPng(
  naturalWidth: number,
  naturalHeight: number,
  box: EditRegionBox
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, naturalWidth, naturalHeight);
  const { sx, sy, sw, sh } = regionToPixelRect(box, naturalWidth, naturalHeight);
  ctx.fillStyle = "#fff";
  ctx.fillRect(sx, sy, sw, sh);
  return canvas.toDataURL("image/png");
}
