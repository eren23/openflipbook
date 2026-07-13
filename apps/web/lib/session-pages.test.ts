import type { SceneView } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import {
  foldSceneViewStamp,
  nodeToPage,
  type SessionNodeWire,
} from "./session-pages";

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

describe("foldSceneViewStamp (SSE final's interior arrival stamp)", () => {
  const prior: SceneView = {
    node_id: "n1",
    level: "street",
    observer: null,
    map_crop: null,
    focus_id: "geo_e1",
    scale_tier: "place",
  };

  it("stamp absent → prior unchanged (pre-stamp behavior byte-identical)", () => {
    expect(foldSceneViewStamp(prior, undefined)).toBe(prior);
    expect(foldSceneViewStamp(undefined, undefined)).toBeNull();
  });

  it("prior null + INTERIOR stamp → mints the minimal eye frame (live-caught: a ladder TRANSITION enter sends no scene_view, and the old null rule dropped the marker from state AND persistence)", () => {
    const minted = foldSceneViewStamp(null, {
      scale_tier: "room",
      place_form: "interior",
    });
    expect(minted).toEqual({
      node_id: "",
      level: "eye",
      observer: null,
      map_crop: null,
      scale_tier: "room",
      place_form: "interior",
    });
  });

  it("prior null + non-interior stamp → still null (nothing to anchor)", () => {
    expect(foldSceneViewStamp(null, { scale_tier: "place" })).toBeNull();
  });

  it("merges the stamp over the prior — stamp wins per-field, rest survives", () => {
    const folded = foldSceneViewStamp(prior, {
      scale_tier: "room",
      place_form: "interior",
    });
    expect(folded).toEqual({ ...prior, scale_tier: "room", place_form: "interior" });
    expect(folded?.place_form).toBe("interior");
    expect(folded?.focus_id).toBe("geo_e1"); // the frame the stamp anchors to
  });
});
