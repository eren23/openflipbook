import type { ViewLevel } from "@openflipbook/config";

export interface NodeKind {
  // The view this node IS (map / building / scene).
  levelGlyph: string;
  levelLabel: string;
  // Tile-frame colour by level — so the TYPE is readable at any zoom, not just
  // from the (corner) badge.
  levelColor: string;
  // How it hangs off its parent (root / a tap-in / an expanded neighbour).
  relGlyph: string;
  relLabel: string;
}

const LEVELS: Record<ViewLevel, { glyph: string; label: string; color: string }> = {
  map: { glyph: "🗺", label: "map", color: "#d97706" }, // amber
  building: { glyph: "🏛", label: "building", color: "#7c3aed" }, // violet
  street: { glyph: "👁", label: "street", color: "#0891b2" }, // cyan
  eye: { glyph: "👁", label: "scene", color: "#475569" }, // slate
};
const PAGE_FALLBACK = { glyph: "📄", label: "page", color: "#9ca3af" };

// Legend for the atlas/map chrome — sourced from the same table so the glyph +
// frame-colour vocabulary stays in sync with the tiles.
export const NODE_KIND_LEGEND = [LEVELS.map, LEVELS.building, LEVELS.eye];

// The human-legible TYPE + RELATIONSHIP of a session node, for the atlas / map
// tile chrome — so a sub-part, a sub-sub-part, an expanded neighbour, and the
// root map don't all read the same. Pure; the data already lives on every node.
export function nodeKind(opts: {
  level?: ViewLevel | null;
  relation?: "descend" | "expand" | "ascend" | null;
  isRoot: boolean;
}): NodeKind {
  const lv = (opts.level && LEVELS[opts.level]) || PAGE_FALLBACK;
  const rel = opts.isRoot
    ? { glyph: "◆", label: "root" }
    : opts.relation === "expand"
      ? { glyph: "⤢", label: "expanded" }
      : opts.relation === "ascend"
        ? { glyph: "⤡", label: "container" } // OUTWARD — the synthesized parent
        : { glyph: "↓", label: "inside" };
  return {
    levelGlyph: lv.glyph,
    levelLabel: lv.label,
    levelColor: lv.color,
    relGlyph: rel.glyph,
    relLabel: rel.label,
  };
}
