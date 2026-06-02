import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import AtlasView, { type AtlasNode } from "./atlas-view";

/**
 * M3 phase 3 — LOD level composition. The atlas walks the tree assigning each
 * node an absolute scale-level (parent's level + the child's scale step), which
 * is what the zoom-reveal band maps onto. The band math itself lives in
 * world-layout.lod.test.ts; this proves the per-node level is composed and
 * threaded into the rendered tree. Camera-independent (happy-dom has no
 * layout), so it's stable.
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

function levelOf(container: HTMLElement, nodeId: string): number {
  const el = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
  if (!el) throw new Error(`no tile for ${nodeId}`);
  return Number(el.dataset.scaleLevel);
}

describe("AtlasView LOD scale-levels (M3 phase 3)", () => {
  it("composes absolute scale-levels down the tree (container +1, component -1 per hop)", () => {
    const click = { xPct: 0.5, yPct: 0.5 };
    const nodes: AtlasNode[] = [
      node({ id: "root" }), // 0
      node({ id: "down", parentId: "root", relation: "descend", scale: "component", clickInParent: { xPct: 0.3, yPct: 0.5 } }), // -1
      node({ id: "out", parentId: "root", relation: "expand", scale: "container", clickInParent: { xPct: 0.7, yPct: 0.5 } }), // +1
      node({ id: "deep", parentId: "down", relation: "descend", scale: "component", clickInParent: click }), // -2
    ];
    const { container } = render(
      <AtlasView sessionId="s1" nodes={nodes} latestNodeId="deep" rootTitle="root" />,
    );
    expect(levelOf(container, "root")).toBe(0);
    expect(levelOf(container, "down")).toBe(-1);
    expect(levelOf(container, "out")).toBe(1);
    expect(levelOf(container, "deep")).toBe(-2);
  });

  it("treats scale-less nodes as level 0 (back-compat)", () => {
    const nodes: AtlasNode[] = [
      node({ id: "root" }),
      node({ id: "kid", parentId: "root", clickInParent: { xPct: 0.5, yPct: 0.5 } }),
    ];
    const { container } = render(
      <AtlasView sessionId="s1" nodes={nodes} latestNodeId="kid" rootTitle="root" />,
    );
    expect(levelOf(container, "root")).toBe(0);
    expect(levelOf(container, "kid")).toBe(0);
  });
});
