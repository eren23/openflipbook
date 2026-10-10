import type { ImageLedLandmark, ImageLedPoint } from "./image-led-walk";

export type SourceSector = "ahead" | "ahead_right" | "right" | "behind_right" | "behind" | "behind_left" | "left" | "ahead_left" | "at_checkpoint";
export interface ImageLedRouteIntent {
  version: 1;
  basis: "source-image-pixels";
  registration: "estimated";
  source_sha256: string;
  map_dimensions: { width: number; height: number };
  checkpoint_index: number;
  checkpoints: {
    index: number; point: ImageLedPoint; heading_degrees: number; turn_from_previous_degrees: number;
    turn: "start" | "continue" | "left" | "right" | "end";
    landmark_relations: { id: string; label: string; anchor: ImageLedPoint; relative_bearing_degrees: number; sector: SourceSector }[];
  }[];
}
const sectors: SourceSector[] = ["ahead", "ahead_right", "right", "behind_right", "behind", "behind_left", "left", "ahead_left"];
const rounded = (n: number) => Math.round(n * 1e6) / 1e6;
const wrapped = (n: number) => ((n + 180) % 360 + 360) % 360 - 180;
const delta = (n: number) => { const v = rounded(wrapped(n)); return v === 180 ? -180 : v; };
const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Map-plane evidence only. Oblique illustration angles are not ground yaw, distance, FOV or visibility. */
export function imageLedRouteIntent(input: {
  source: { width: number; height: number; sha256: string };
  points: ImageLedPoint[];
  landmarks: Pick<ImageLedLandmark, "id" | "label" | "source_rectangle">[];
  checkpointIndex: number;
}): ImageLedRouteIntent {
  const { source, points, landmarks, checkpointIndex } = input;
  const { width, height } = source;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 32 || height < 32 || width > 4096 || height > 4096
    || !/^[a-f0-9]{64}$/.test(source.sha256) || points.length < 2 || points.length > 12
    || !Number.isInteger(checkpointIndex) || checkpointIndex < 0 || checkpointIndex >= points.length
    || points.some(p => !unit(p.x) || !unit(p.y))
    || points.some((p, i) => i > 0 && p.x === points[i - 1]!.x && p.y === points[i - 1]!.y)) throw new RangeError("Invalid original-image route intent");
  if (landmarks.length > 8 || new Set(landmarks.map(l => l.id)).size !== landmarks.length) throw new RangeError("Invalid source landmark inventory");
  const anchors = landmarks.map(l => {
    const r = l.source_rectangle;
    if (![r.left, r.top, r.width, r.height].every(Number.isSafeInteger) || r.left < 0 || r.top < 0 || r.width < 1 || r.height < 1
      || r.left + r.width > width || r.top + r.height > height) throw new RangeError("Source landmark is outside the original image");
    return { id: l.id, label: l.label, anchor: { x: (r.left + r.width / 2) / width, y: (r.top + r.height / 2) / height } };
  });
  // Face the outgoing local segment. At the end, keep the incoming heading;
  // reaching the last marker does not prove arrival at any particular landmark.
  const headings = points.map((p, i) => {
    const a = i === points.length - 1 ? points[i - 1]! : p;
    const b = i === points.length - 1 ? p : points[i + 1]!;
    return (Math.atan2((b.x - a.x) * width, -(b.y - a.y) * height) * 180 / Math.PI + 360) % 360;
  });
  const checkpoints: ImageLedRouteIntent["checkpoints"] = points.map((p, i) => {
    const turn = i ? wrapped(headings[i]! - headings[i - 1]!) : 0;
    return {
      index: i, point: { ...p }, heading_degrees: rounded(headings[i]!) % 360, turn_from_previous_degrees: delta(turn),
      turn: i === 0 ? "start" : i === points.length - 1 ? "end" : Math.abs(turn) < 5 ? "continue" : turn < 0 ? "left" : "right",
      landmark_relations: anchors.map(l => {
        const dx = (l.anchor.x - p.x) * width, dy = (l.anchor.y - p.y) * height;
        const at = Math.hypot(dx, dy) < 1e-6;
        const relative = at ? 0 : wrapped(Math.atan2(dx, -dy) * 180 / Math.PI - headings[i]!);
        const sector = at ? "at_checkpoint" : sectors[((Math.floor((relative + 22.5) / 45) % 8) + 8) % 8]!;
        return { ...l, relative_bearing_degrees: delta(relative), sector };
      }),
    };
  });
  return { version: 1, basis: "source-image-pixels", registration: "estimated", source_sha256: source.sha256,
    map_dimensions: { width, height }, checkpoint_index: checkpointIndex, checkpoints };
}
