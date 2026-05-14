import { describe, expect, it } from "vitest";

import {
  arcPath,
  depthTint,
  fitAllCamera,
  fitCamera,
  layoutPages,
} from "./world-layout";

describe("layoutPages", () => {
  it("returns an empty layout for no inputs", () => {
    expect(layoutPages([])).toEqual({ pages: [], connectors: [] });
  });

  it("places a single root at the origin with no connectors", () => {
    const out = layoutPages([
      { nodeId: "r", parentId: null, imageDataUrl: null, title: "root" },
    ]);
    expect(out.connectors).toHaveLength(0);
    expect(out.pages).toHaveLength(1);
    const root = out.pages[0]!;
    expect(root.rect.x).toBe(0);
    expect(root.rect.y).toBe(0);
    expect(root.rect.w).toBeGreaterThan(0);
    expect(root.rect.h).toBeGreaterThan(0);
    expect(root.parentId).toBeNull();
    expect(root.parentClickPoint).toBeNull();
  });

  it("emits a connector from parent click point to child edge", () => {
    const out = layoutPages([
      { nodeId: "p", parentId: null, imageDataUrl: null, title: "parent" },
      {
        nodeId: "c",
        parentId: "p",
        imageDataUrl: null,
        title: "child",
        clickInParent: { xPct: 0.9, yPct: 0.5 },
      },
    ]);
    expect(out.pages).toHaveLength(2);
    expect(out.connectors).toHaveLength(1);
    const child = out.pages.find((p) => p.nodeId === "c")!;
    expect(child.parentClickPoint).not.toBeNull();
    // Click is on the right edge of the parent so the child should land
    // somewhere to the right of the parent.
    const parent = out.pages.find((p) => p.nodeId === "p")!;
    expect(child.rect.x).toBeGreaterThan(parent.rect.x);

    const connector = out.connectors[0]!;
    expect(connector.fromNodeId).toBe("p");
    expect(connector.toNodeId).toBe("c");
    // `from` should equal the parent click point in world coords.
    expect(connector.from.x).toBeCloseTo(
      parent.rect.x + 0.9 * parent.rect.w,
      5,
    );
  });

  it("multiple siblings do not share the same rect", () => {
    const out = layoutPages([
      { nodeId: "p", parentId: null, imageDataUrl: null, title: "parent" },
      {
        nodeId: "c1",
        parentId: "p",
        imageDataUrl: null,
        title: "c1",
        clickInParent: { xPct: 0.5, yPct: 0.5 },
      },
      {
        nodeId: "c2",
        parentId: "p",
        imageDataUrl: null,
        title: "c2",
        clickInParent: { xPct: 0.5, yPct: 0.5 },
      },
    ]);
    const c1 = out.pages.find((p) => p.nodeId === "c1")!;
    const c2 = out.pages.find((p) => p.nodeId === "c2")!;
    const sameSpot = c1.rect.x === c2.rect.x && c1.rect.y === c2.rect.y;
    expect(sameSpot).toBe(false);
  });

  it("orphans (unknown parentId) get treated as roots", () => {
    const out = layoutPages([
      {
        nodeId: "ghost-child",
        parentId: "ghost-parent",
        imageDataUrl: null,
        title: "stranded",
      },
    ]);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]!.rect.x).toBe(0);
    expect(out.connectors).toHaveLength(0);
  });
});

describe("fitCamera", () => {
  it("centres on the rect midpoint", () => {
    const cam = fitCamera({ x: 100, y: 200, w: 800, h: 400 }, 1600, 800);
    expect(cam.cx).toBe(500);
    expect(cam.cy).toBe(400);
    expect(cam.zoom).toBeGreaterThan(0);
  });

  it("returns the smaller zoom (axis with less slack)", () => {
    // 800-tall rect into a 1600x400 viewport — height is the binding axis.
    const cam = fitCamera({ x: 0, y: 0, w: 100, h: 800 }, 1600, 400, 0);
    expect(cam.zoom).toBe(0.5);
  });
});

describe("arcPath", () => {
  it("returns a cubic-bezier path string between two points", () => {
    const d = arcPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(d).toMatch(/^M\s*0\s+0\s+C/);
    expect(d).toContain("100");
    // Cubic bezier has exactly 3 coordinate pairs after the C command.
    const coordsAfterC = d.split("C")[1]!.trim();
    expect(coordsAfterC.split(/[\s,]+/).filter(Boolean)).toHaveLength(6);
  });

  it("pins the exact control-point coords for a horizontal segment", () => {
    // For a horizontal from→to, the perpendicular bend shows up entirely in
    // c1y / c2y. With bend factor 0.18 and len 100, that's ±18. Any drift in
    // the bend constant or the 0.33 / 0.67 anchor splits trips this test.
    expect(arcPath({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(
      "M 0 0 C 33 18, 67 -18, 100 0",
    );
  });

  it("bends perpendicular to the from→to direction", () => {
    // A straight horizontal arc should curve out of the y=0 axis.
    const d = arcPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // The two control-point ys should be non-zero (bend).
    const c1y = nums[3]!;
    const c2y = nums[5]!;
    expect(c1y !== 0 || c2y !== 0).toBe(true);
  });

  it("degenerate identical endpoints return a still-valid path", () => {
    const d = arcPath({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(d).toMatch(/^M\s*50\s+50\s+C/);
    // No NaNs.
    expect(d).not.toMatch(/NaN/);
  });
});

describe("depthTint", () => {
  it("depth 0 is full saturation and opacity (root)", () => {
    const t = depthTint(0);
    expect(t.saturation).toBe(1);
    expect(t.opacity).toBe(1);
  });

  it("deeper nodes desaturate slightly so the eye reads depth", () => {
    const root = depthTint(0);
    const deep = depthTint(5);
    expect(deep.saturation).toBeLessThan(root.saturation);
    expect(deep.opacity).toBeLessThan(root.opacity);
  });

  it("clamps at a floor — depths past 10 do not collapse to zero", () => {
    const wayDeep = depthTint(100);
    expect(wayDeep.saturation).toBeGreaterThan(0.4);
    expect(wayDeep.opacity).toBeGreaterThan(0.55);
  });

  it("never returns NaN for negative or non-integer depths", () => {
    expect(Number.isFinite(depthTint(-1).saturation)).toBe(true);
    expect(Number.isFinite(depthTint(2.5).opacity)).toBe(true);
  });
});

describe("fitAllCamera", () => {
  it("returns a default camera for empty input", () => {
    expect(fitAllCamera([], 100, 100)).toEqual({ cx: 0, cy: 0, zoom: 1 });
  });

  it("covers the bounding box of all rects", () => {
    const cam = fitAllCamera(
      [
        {
          nodeId: "a",
          rect: { x: 0, y: 0, w: 100, h: 100 },
          imageDataUrl: null,
          title: "a",
          parentId: null,
          parentClickPoint: null,
        },
        {
          nodeId: "b",
          rect: { x: 200, y: 200, w: 100, h: 100 },
          imageDataUrl: null,
          title: "b",
          parentId: null,
          parentClickPoint: null,
        },
      ],
      1000,
      1000,
    );
    expect(cam.cx).toBe(150);
    expect(cam.cy).toBe(150);
    expect(cam.zoom).toBeGreaterThan(0);
  });
});
