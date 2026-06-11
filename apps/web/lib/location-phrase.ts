import type { MapCrop, WorldEntityGeo } from "@openflipbook/config";

// Geo → compass phrase for the world-continuity prompt ("fixed position: the
// north-west of the map"). The spatial half of continuity: world_context has
// always locked APPEARANCE while leaving the model free to relocate landmarks
// (the Patrician's-Palace-on-the-riverbank incident); this phrase pins them.
// +y = south in the map frame (see world-geometry.ts); thirds give a 3×3
// compass grid, and edge-spanning entities (rivers, walls) are called out as
// spans rather than cells.

export function locationPhrase(
  geo: Pick<WorldEntityGeo, "pos" | "footprint">,
  frame: MapCrop,
): string | null {
  if (!frame.w || !frame.h) return null;
  const fx = (geo.pos.x - frame.x) / frame.w;
  const fy = (geo.pos.y - frame.y) / frame.h;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  // Outside the frame (stale geo / sub-frame leak) -> no claim beats a wrong one.
  if (fx < -0.05 || fx > 1.05 || fy < -0.05 || fy > 1.05) return null;
  const row = fy < 1 / 3 ? "north" : fy > 2 / 3 ? "south" : "";
  const col = fx < 1 / 3 ? "west" : fx > 2 / 3 ? "east" : "";
  const spansEW = geo.footprint.w >= frame.w * 0.6;
  const spansNS = geo.footprint.d >= frame.h * 0.6;
  if (spansEW && spansNS) return "spanning the whole map";
  if (spansEW)
    return `spanning the map east–west across its ${row || "middle"}`;
  if (spansNS)
    return `spanning the map north–south through its ${col || "middle"}`;
  if (!row && !col) return "the center of the map";
  return `the ${row && col ? `${row}-${col}` : row || col} of the map`;
}
