import { describe, expect, it } from "vitest";

import { fitAllCamera, fitCamera, layoutPages } from "./world-layout";

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
