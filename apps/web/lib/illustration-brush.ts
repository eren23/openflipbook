import { CreatorError } from "./creator-error";

export interface IllustrationBrushStroke {
  operation: "paint" | "erase";
  radius: number;
  points: [number, number][];
}

export function brushStrokes(value: unknown, width: number, height: number): IllustrationBrushStroke[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new CreatorError("Use at most 32 brush strokes", 400);
  let points = 0, work = 0;
  return value.map(stroke => {
    if (!stroke || typeof stroke !== "object" || Object.keys(stroke).some(k => !["operation", "radius", "points"].includes(k))
      || !["paint", "erase"].includes(stroke.operation) || !Number.isInteger(stroke.radius) || stroke.radius < 1 || stroke.radius > 64
      || !Array.isArray(stroke.points) || !stroke.points.length) throw new CreatorError("Invalid registered brush stroke", 400);
    const path = stroke.points.map((point: unknown) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) || point[0] < 0 || point[1] < 0 || point[0] >= width || point[1] >= height) throw new CreatorError("Brush points must be inside the saved image", 400);
      if (++points > 512) throw new CreatorError("Use at most 512 brush points", 400);
      return [point[0], point[1]] as [number, number];
    });
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)]!, b = path[i]!;
      work += (Math.abs(a[0] - b[0]) + stroke.radius * 2 + 1) * (Math.abs(a[1] - b[1]) + stroke.radius * 2 + 1);
    }
    if (work > 8_000_000) throw new CreatorError("Brush selection is too complex; use fewer or shorter strokes", 400);
    return { operation: stroke.operation, radius: stroke.radius, points: path };
  });
}

// Shared binary pixel-centre coverage keeps browser overlay and server clipping
// identical; browser canvas antialiasing is not used as the accepted mask.
export function brushPixels(strokes: IllustrationBrushStroke[], width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || width > 1024 || height > 1024) throw new CreatorError("Invalid brush image dimensions", 400);
  const checked = brushStrokes(strokes, width, height)!, output = new Uint8Array(width * height);
  for (const stroke of checked) for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!, r = stroke.radius;
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const left = Math.max(0, Math.min(a[0], b[0]) - r), right = Math.min(width - 1, Math.max(a[0], b[0]) + r);
    const top = Math.max(0, Math.min(a[1], b[1]) - r), bottom = Math.min(height - 1, Math.max(a[1], b[1]) + r);
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const t = length2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2)) : 0;
      if ((x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 <= r * r) output[y * width + x] = stroke.operation === "paint" ? 255 : 0;
    }
  }
  return output;
}
