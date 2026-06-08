import { describe, expect, it } from "vitest";

import { nodeKind } from "./node-kind";

describe("nodeKind", () => {
  it("the root map", () => {
    const k = nodeKind({ level: "map", relation: null, isRoot: true });
    expect(k.levelGlyph).toBe("🗺");
    expect(k.levelLabel).toBe("map");
    expect(k.levelColor).toBe("#d97706"); // amber frame
    expect(k.relLabel).toBe("root");
  });

  it("a tapped-in building reads as descend/inside", () => {
    const k = nodeKind({ level: "building", relation: "descend", isRoot: false });
    expect(k.levelLabel).toBe("building");
    expect(k.relGlyph).toBe("↓");
    expect(k.relLabel).toBe("inside");
  });

  it("an expanded neighbour reads as expanded", () => {
    const k = nodeKind({ level: "eye", relation: "expand", isRoot: false });
    expect(k.levelLabel).toBe("scene");
    expect(k.relLabel).toBe("expanded");
  });

  it("a pre-geometry node (no level) falls back to a page glyph", () => {
    const k = nodeKind({ level: null, relation: "descend", isRoot: false });
    expect(k.levelGlyph).toBe("📄");
    expect(k.levelLabel).toBe("page");
    expect(k.levelColor).toBe("#9ca3af"); // neutral frame for pre-geo nodes
  });
});
