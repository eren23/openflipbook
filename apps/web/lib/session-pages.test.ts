import { describe, expect, it } from "vitest";

import { nodeToPage, type SessionNodeWire } from "./session-pages";

function wire(overrides: Partial<SessionNodeWire> = {}): SessionNodeWire {
  return {
    id: "n1",
    parent_id: null,
    session_id: "s1",
    query: "q",
    page_title: "t",
    image_url: "https://cdn/img.jpg",
    click_in_parent: null,
    ...overrides,
  };
}

describe("nodeToPage (?continue= hydration)", () => {
  it("maps the node row onto a Page (fields + click point)", () => {
    const p = nodeToPage(
      wire({
        parent_id: "n0",
        click_in_parent: { x_pct: 0.25, y_pct: 0.75 },
        sources: [{ url: "https://a", title: "A" }],
      }),
    );
    expect(p.nodeId).toBe("n1");
    expect(p.sessionId).toBe("s1");
    expect(p.title).toBe("t");
    expect(p.imageDataUrl).toBe("https://cdn/img.jpg");
    expect(p.parentId).toBe("n0");
    expect(p.clickInParent).toEqual({ xPct: 0.25, yPct: 0.75 });
    expect(p.sources).toEqual([{ url: "https://a", title: "A" }]);
  });

  it("rides relation from the node row — an expand-bloomed child hydrates as an expand Page", () => {
    expect(nodeToPage(wire({ relation: "expand" })).relation).toBe("expand");
    expect(nodeToPage(wire({ relation: "edit" })).relation).toBe("edit");
    expect(nodeToPage(wire({ relation: "ascend" })).relation).toBe("ascend");
  });

  it("keeps explicit descend (the atlas/layout key their nesting shrink on it)", () => {
    expect(nodeToPage(wire({ relation: "descend" })).relation).toBe("descend");
  });

  it("leaves relation absent when a pre-relation server omits it (descend semantics)", () => {
    expect("relation" in nodeToPage(wire())).toBe(false);
  });
});
