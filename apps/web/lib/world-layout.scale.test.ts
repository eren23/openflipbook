import { describe, expect, it } from "vitest";

import { layoutPages, type LayoutInput } from "./world-layout";

const PAGE_W = 1600;
const PAGE_H = 900;

type Rect = { x: number; y: number; w: number; h: number };

function rectOf(pages: ReturnType<typeof layoutPages>["pages"], id: string): Rect {
  const p = pages.find((q) => q.nodeId === id);
  if (!p) throw new Error(`no node ${id}`);
  return p.rect;
}

function distFromParent(parent: Rect, child: Rect): number {
  return Math.hypot(
    child.x + child.w / 2 - (parent.x + parent.w / 2),
    child.y + child.h / 2 - (parent.y + parent.h / 2),
  );
}

function kid(nodeId: string, scale?: "component" | "peer" | "container"): LayoutInput {
  return {
    nodeId,
    parentId: "root",
    imageDataUrl: null,
    title: nodeId,
    clickInParent: { xPct: 0.5, yPct: 0.5 },
    ...(scale ? { scale } : {}),
  };
}

const ROOT: LayoutInput = {
  nodeId: "root",
  parentId: null,
  imageDataUrl: null,
  title: "root",
};

describe("world-layout scale gradient (M3 phase 2)", () => {
  it("sizes child rects by scale — container > peer > component, aspect preserved", () => {
    const { pages } = layoutPages([
      ROOT,
      kid("big", "container"),
      kid("mid", "peer"),
      kid("small", "component"),
    ]);
    expect(rectOf(pages, "mid").w).toBe(PAGE_W); // peer = default
    expect(rectOf(pages, "big").w).toBeGreaterThan(PAGE_W);
    expect(rectOf(pages, "small").w).toBeLessThan(PAGE_W);
    const b = rectOf(pages, "big");
    expect(b.w / b.h).toBeCloseTo(PAGE_W / PAGE_H, 5); // aspect ratio kept
  });

  it("places bigger-scale children farther from the parent than smaller ones", () => {
    const { pages } = layoutPages([
      ROOT,
      kid("big", "container"),
      kid("small", "component"),
    ]);
    const root = rectOf(pages, "root");
    expect(distFromParent(root, rectOf(pages, "big"))).toBeGreaterThan(
      distFromParent(root, rectOf(pages, "small")),
    );
  });

  it("leaves scale-less children at the exact default size (back-compat)", () => {
    const { pages } = layoutPages([ROOT, kid("plain")]);
    expect(rectOf(pages, "plain").w).toBe(PAGE_W);
    expect(rectOf(pages, "plain").h).toBe(PAGE_H);
  });
});
