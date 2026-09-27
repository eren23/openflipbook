import type { ViewCapture } from "./place-view";

export interface LandmarkPixels {
  object_id: string; pixels: number; fraction: number;
  centroid: [number, number] | null;
  bounds: [number, number, number, number] | null;
  touches_frame: boolean;
}

// Measurements are of visible opaque mask pixels, not inferred full silhouettes
// or persistent surface feature tracks. Coordinates are normalized, top-left.
export function measureMotionLandmarks(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  objects: ViewCapture["objects"]): { landmarks: LandmarkPixels[]; unknown_pixels: number } {
  if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 1024) || rgba.length !== width * height * 4
    || objects.length > 1000) throw new Error("Invalid motion reference mask dimensions");
  const colors = new Map<number, number>(), ids = new Set<string>();
  const stats = objects.map((object, index) => {
    if (!object.object_id || ids.has(object.object_id) || object.rgb.length !== 3 || object.rgb.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("Invalid motion landmark identity");
    const color = object.rgb[0] * 65536 + object.rgb[1] * 256 + object.rgb[2];
    if (!color || colors.has(color)) throw new Error("Ambiguous motion landmark color");
    ids.add(object.object_id); colors.set(color, index);
    return { count: 0, sx: 0, sy: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
  });
  let unknown = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (rgba[offset + 3] !== 255) { unknown++; continue; }
    const color = rgba[offset]! * 65536 + rgba[offset + 1]! * 256 + rgba[offset + 2]!;
    if (!color) continue;
    const index = colors.get(color);
    if (index === undefined) { unknown++; continue; }
    const s = stats[index]!;
    s.count++; s.sx += x + 0.5; s.sy += y + 0.5;
    s.minX = Math.min(s.minX, x); s.minY = Math.min(s.minY, y);
    s.maxX = Math.max(s.maxX, x); s.maxY = Math.max(s.maxY, y);
  }
  return { unknown_pixels: unknown, landmarks: objects.map((object, index) => {
    const s = stats[index]!;
    return { object_id: object.object_id, pixels: s.count, fraction: s.count / (width * height),
      centroid: s.count ? [s.sx / s.count / width, s.sy / s.count / height] : null,
      bounds: s.count ? [s.minX / width, s.minY / height, (s.maxX + 1) / width, (s.maxY + 1) / height] : null,
      touches_frame: s.count > 0 && (s.minX === 0 || s.minY === 0 || s.maxX === width - 1 || s.maxY === height - 1) };
  }) };
}
