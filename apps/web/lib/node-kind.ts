import type { ViewLevel } from "@openflipbook/config";

export interface NodeKind {
  // The view this node IS (map / building / scene).
  levelGlyph: string;
  levelLabel: string;
  // How it hangs off its parent (root / a tap-in / an expanded neighbour).
  relGlyph: string;
  relLabel: string;
}

const LEVELS: Record<ViewLevel, { glyph: string; label: string }> = {
  map: { glyph: "🗺", label: "map" },
  building: { glyph: "🏛", label: "building" },
  street: { glyph: "👁", label: "street" },
  eye: { glyph: "👁", label: "scene" },
};

// The human-legible TYPE + RELATIONSHIP of a session node, for the atlas / map
// tile chrome — so a sub-part, a sub-sub-part, an expanded neighbour, and the
// root map don't all read the same. Pure; the data already lives on every node.
export function nodeKind(opts: {
  level?: ViewLevel | null;
  relation?: "descend" | "expand" | null;
  isRoot: boolean;
}): NodeKind {
  const lv =
    (opts.level && LEVELS[opts.level]) || { glyph: "📄", label: "page" };
  const rel = opts.isRoot
    ? { glyph: "◆", label: "root" }
    : opts.relation === "expand"
      ? { glyph: "⤢", label: "expanded" }
      : { glyph: "↓", label: "inside" };
  return {
    levelGlyph: lv.glyph,
    levelLabel: lv.label,
    relGlyph: rel.glyph,
    relLabel: rel.label,
  };
}
