import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import WorldMap from "./world-map";
import type { LayoutInput } from "@/lib/world-layout";

/**
 * In-session expand connectors — the in-page 🗺 map must read breadth
 * (expand blooms) distinctly from depth (taps), matching the atlas: teal
 * edges + hollow tap-anchorless styling for expand vs ink + red dot for
 * descend. The layout math is world-layout.test.ts territory; this pins the
 * relation → edge/tile-badge rendering contract. Like the atlas scale tests,
 * children get a clickInParent so layoutPages emits connectors at all.
 */

function page(partial: Partial<LayoutInput> & { nodeId: string }): LayoutInput {
  return {
    parentId: null,
    imageDataUrl: null,
    title: partial.nodeId,
    ...partial,
  };
}

const PAGES: LayoutInput[] = [
  page({ nodeId: "root" }),
  page({
    nodeId: "down",
    parentId: "root",
    relation: "descend",
    clickInParent: { xPct: 0.3, yPct: 0.5 },
  }),
  page({
    nodeId: "out",
    parentId: "root",
    relation: "expand",
    clickInParent: { xPct: 0.7, yPct: 0.5 },
  }),
];

describe("WorldMap in-session relation rendering", () => {
  it("styles an expand edge teal, distinct from the descend ink + red tap dot", () => {
    const { container } = render(
      <WorldMap
        pages={PAGES}
        activeNodeId="root"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const expandEdge = container.querySelector('g[data-relation="expand"]');
    const descendEdge = container.querySelector('g[data-relation="descend"]');
    expect(expandEdge).not.toBeNull();
    expect(descendEdge).not.toBeNull();
    // Teal (13,148,136) stroke + expand arrowhead for breadth…
    expect(expandEdge!.querySelector("path")?.getAttribute("stroke")).toContain(
      "13,148,136",
    );
    expect(
      expandEdge!.querySelector("path")?.getAttribute("marker-end"),
    ).toContain("expand");
    // …vs ink stroke + red source dot for depth.
    expect(
      descendEdge!.querySelector("path")?.getAttribute("stroke"),
    ).toContain("15,15,15");
    expect(
      descendEdge!.querySelector("circle")?.getAttribute("fill"),
    ).toContain("239,68,68");
  });

  it("badges an expand tile as 'expanded' (the read for bloomed pages without a tap point)", () => {
    const { container } = render(
      <WorldMap
        pages={PAGES}
        activeNodeId="root"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const badges = [
      ...container.querySelectorAll('[data-testid="map-tile-kind"]'),
    ].map((b) => b.getAttribute("title") ?? "");
    expect(badges.some((t) => /expanded/.test(t))).toBe(true);
    expect(badges.some((t) => /inside/.test(t))).toBe(true);
  });
});
