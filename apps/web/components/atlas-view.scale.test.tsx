import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import type { SceneView } from "@openflipbook/config";

import AtlasView, { type AtlasNode } from "./atlas-view";

/**
 * M3 phase 2 — the scale-space data path through the atlas. These prove the
 * threading NodeRow→AtlasNode→LayoutInput→render carries `relation`/`scale`
 * end to end, and that an expand (breadth) edge renders distinctly from a
 * descend (depth) edge. The layout *math* is covered by
 * world-layout.scale.test.ts; this is the wiring + rendering contract.
 */

function node(partial: Partial<AtlasNode> & { id: string }): AtlasNode {
  return {
    parentId: null,
    title: partial.id,
    query: partial.id,
    imageUrl: "",
    clickInParent: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    imageModel: "test",
    promptAuthorModel: "test",
    ...partial,
  } as AtlasNode;
}

function tileWidth(container: HTMLElement, nodeId: string): number {
  const el = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
  if (!el) throw new Error(`no tile for ${nodeId}`);
  return parseFloat(el.style.width);
}

describe("AtlasView scale-space rendering (M3 phase 2)", () => {
  it("tags each connector with the child's relation so expand reads distinctly from descend", () => {
    const nodes: AtlasNode[] = [
      node({ id: "root" }),
      node({
        id: "down",
        parentId: "root",
        relation: "descend",
        scale: "peer",
        clickInParent: { xPct: 0.3, yPct: 0.5 },
      }),
      node({
        id: "out",
        parentId: "root",
        relation: "expand",
        scale: "container",
        clickInParent: { xPct: 0.7, yPct: 0.5 },
      }),
    ];
    const { container } = render(
      <AtlasView sessionId="s1" nodes={nodes} latestNodeId="out" rootTitle="root" />,
    );
    expect(container.querySelector('[data-relation="expand"]')).not.toBeNull();
    expect(container.querySelector('[data-relation="descend"]')).not.toBeNull();
  });

  it("tags each tile with its TYPE + relationship so they don't all read the same", () => {
    const nodes: AtlasNode[] = [
      node({ id: "root" }),
      node({
        id: "uni",
        parentId: "root",
        relation: "descend",
        clickInParent: { xPct: 0.5, yPct: 0.5 },
      }),
    ];
    const sceneViews: Record<string, SceneView> = {
      root: { node_id: "root", level: "map", observer: null, map_crop: { x: 0, y: 0, w: 100, h: 60 }, focus_id: null },
      uni: { node_id: "uni", level: "building", observer: null, map_crop: null, focus_id: "g_uni" },
    };
    const { container } = render(
      <AtlasView
        sessionId="s1"
        nodes={nodes}
        latestNodeId="uni"
        rootTitle="root"
        sceneViews={sceneViews}
      />,
    );
    const titles = [...container.querySelectorAll('[data-testid="tile-kind"]')].map(
      (b) => b.getAttribute("title") ?? "",
    );
    expect(titles.some((t) => /map/.test(t) && /root/.test(t))).toBe(true);
    expect(titles.some((t) => /building/.test(t) && /inside/.test(t))).toBe(true);
  });

  it("sizes tiles by the node's scale — a container expand-neighbour looms larger than a peer", () => {
    const nodes: AtlasNode[] = [
      node({ id: "root" }),
      node({
        id: "peer",
        parentId: "root",
        relation: "expand",
        scale: "peer",
        clickInParent: { xPct: 0.3, yPct: 0.5 },
      }),
      node({
        id: "big",
        parentId: "root",
        relation: "expand",
        scale: "container",
        clickInParent: { xPct: 0.7, yPct: 0.5 },
      }),
    ];
    const { container } = render(
      <AtlasView sessionId="s1" nodes={nodes} latestNodeId="big" rootTitle="root" />,
    );
    expect(tileWidth(container, "big")).toBeGreaterThan(tileWidth(container, "peer"));
  });
});
