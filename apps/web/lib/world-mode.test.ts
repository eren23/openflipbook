import { describe, expect, it } from "vitest";

import {
  REVISIT_RADIUS,
  enterAsToRenderMode,
  findRevisitTarget,
  zoomModeForLevel,
} from "./world-mode";

describe("enterAsToRenderMode", () => {
  it("maps scene/submap and defaults to explainer", () => {
    expect(enterAsToRenderMode("scene")).toBe("place_scene");
    expect(enterAsToRenderMode("submap")).toBe("place_submap");
    expect(enterAsToRenderMode("explainer")).toBe("explainer");
    expect(enterAsToRenderMode(undefined)).toBe("explainer");
    expect(enterAsToRenderMode("bogus")).toBe("explainer");
  });
});

describe("zoomModeForLevel (context menu's 🔍 Zoom in here)", () => {
  it("a map frame zooms as an aligned submap cut", () => {
    expect(zoomModeForLevel("map")).toBe("place_submap");
  });

  it("no scene_view (classic/root pages) counts as a map frame", () => {
    expect(zoomModeForLevel(undefined)).toBe("place_submap");
    expect(zoomModeForLevel(null)).toBe("place_submap");
  });

  it("observer levels zoom as a closeup", () => {
    expect(zoomModeForLevel("eye")).toBe("place_closeup");
    expect(zoomModeForLevel("street")).toBe("place_closeup");
    expect(zoomModeForLevel("building")).toBe("place_closeup");
  });
});

describe("findRevisitTarget", () => {
  const items = [
    { nodeId: "a", parentId: "P", clickInParent: { xPct: 0.2, yPct: 0.2 } },
    { nodeId: "b", parentId: "P", clickInParent: { xPct: 0.8, yPct: 0.8 } },
    { nodeId: "c", parentId: "Q", clickInParent: { xPct: 0.21, yPct: 0.21 } },
    { nodeId: "d", parentId: "P" }, // a tap child with no recorded origin
  ];

  it("reopens the nearest child of the current node within radius", () => {
    expect(findRevisitTarget(items, "P", { x_pct: 0.22, y_pct: 0.22 })).toBe("a");
  });

  it("returns null when the tap is outside every child's radius", () => {
    expect(findRevisitTarget(items, "P", { x_pct: 0.5, y_pct: 0.5 })).toBeNull();
  });

  it("ignores children of other parents", () => {
    // (0.21,0.21) is right on c — but c belongs to Q, so under P we get a.
    expect(findRevisitTarget(items, "P", { x_pct: 0.21, y_pct: 0.21 })).toBe("a");
  });

  it("returns null without a current node", () => {
    expect(findRevisitTarget(items, null, { x_pct: 0.2, y_pct: 0.2 })).toBeNull();
  });

  it("respects a custom radius", () => {
    expect(
      findRevisitTarget(items, "P", { x_pct: 0.3, y_pct: 0.2 }, REVISIT_RADIUS),
    ).toBeNull();
    expect(findRevisitTarget(items, "P", { x_pct: 0.3, y_pct: 0.2 }, 0.2)).toBe("a");
  });
});
