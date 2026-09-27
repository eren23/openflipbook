export const CONTROLLED_IDS = ["structural-35-101", "structural-60-101", "structural-35-202", "structural-60-202", "fast-101"] as const;
export type ControlledId = typeof CONTROLLED_IDS[number];
export type Box = [number, number, number, number];
export interface ControlledResult {
  id: ControlledId;
  label: string;
  state: "not_submitted" | "reserved" | "submitted" | "stopped" | "complete";
  visual_verdict: string;
  geometry?: { sampled_geometry: "unverified" | "pass" | "fail"; max_corner_error?: number; threshold: number };
  error?: string;
  reserved_usd?: string | null;
  reported_cost_usd?: string | null;
  metadata?: { width: number; height: number; frame_count: number; duration_seconds: number; fps: string };
}
export interface ControlledReport {
  version: 1;
  cap_usd: string;
  reserved_usd: string;
  complete: boolean;
  results: ControlledResult[];
  fixture: {
    signature: { crop: [number, number, number]; landmark: Box; size: [number, number]; frames: number; fps: number };
    source_size: [number, number];
    content_rect: Box;
    fast_content_rect: Box;
  };
}

const ROOT = "tests/video_transition_bench/reports/controlled-lighthouse";

export function controlledAssetPath(name: string): string | null {
  const inputs: Record<string, string> = {
    "controlled-summary.json": "summary.json",
    "controlled-reference.mp4": "inputs/reference.mp4",
    "controlled-edges.mp4": "inputs/edges.mp4",
    "controlled-first.png": "inputs/first.png",
    "controlled-last.png": "inputs/last.png",
  };
  if (Object.hasOwn(inputs, name)) return `${ROOT}/${inputs[name]}`;
  for (const id of CONTROLLED_IDS) {
    for (const suffix of [".mp4", "-contact.jpg", "-receipt.json"]) {
      if (name === `controlled-${id}${suffix}`) return `${ROOT}/${id}${suffix}`;
    }
  }
  return null;
}

export function expectedLandmark(crop: [number, number, number], landmark: Box, progress: number): Box {
  const t = Math.min(1, Math.max(0, progress));
  const ease = t * t * (3 - 2 * t);
  const scale = 1 + (1 / crop[2] - 1) * ease;
  return [scale * landmark[0] - crop[0] / crop[2] * ease,
    scale * landmark[1] - crop[1] / crop[2] * ease, landmark[2] * scale, landmark[3] * scale];
}

export function canvasBox(box: Box, rect: Box, size: [number, number]): Box {
  return [(rect[0] + box[0] * rect[2]) / size[0], (rect[1] + box[1] * rect[3]) / size[1],
    box[2] * rect[2] / size[0], box[3] * rect[3] / size[1]];
}

export function sampleTime(progress: number, duration: number, frames: number): number {
  return Math.min(1, Math.max(0, progress)) * duration * (frames - 1) / frames;
}
