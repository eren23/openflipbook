import { WORLD, type CameraView } from "../lighthouse-v2/contract";
import appearance from "./appearance.json";
import type { SurfaceMode } from "./world";

export type State = { asset: string; time: number; mode: SurfaceMode; view: CameraView };
export const INITIAL: State = { asset: appearance.id, time: 0, mode: "surface", view: "walk" };
export const KEY = `openflipbook:study:${appearance.id}`;
export function restore(raw: string | null): State {
  try {
    const s = JSON.parse(raw ?? "null");
    if (s?.asset !== appearance.id || !Number.isFinite(s.time) || s.time < 0 || s.time > WORLD.duration ||
        !["surface", "baseline", "clay"].includes(s.mode) || !["walk", "inspection"].includes(s.view)) return { ...INITIAL };
    return { asset: s.asset, time: s.time, mode: s.mode, view: s.view };
  } catch { return { ...INITIAL }; }
}
