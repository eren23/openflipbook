import { describe, expect, it } from "vitest";

import { anchorsFromGeo, layoutLabels, type PlacedLabel } from "./map-labels";

function overlapArea(a: PlacedLabel, b: PlacedLabel): number {
  const w =
    Math.min(a.leftPct + a.wPct, b.leftPct + b.wPct) -
    Math.max(a.leftPct, b.leftPct);
  const h =
    Math.min(a.topPct + a.hPct, b.topPct + b.hPct) -
    Math.max(a.topPct, b.topPct);
  return Math.max(0, w) * Math.max(0, h);
}

describe("layoutLabels (DOM label collision avoidance)", () => {
  it("a lone label sits centred just above its anchor, inside the frame", () => {
    const placed = layoutLabels([
      { id: "a", name: "Patrician's Palace", xPct: 0.5, yPct: 0.4 },
    ]);
    const l = placed[0]!;
    expect(l.leftPct + l.wPct / 2).toBeCloseTo(0.5, 5);
    expect(l.topPct).toBeLessThan(0.4);
    expect(l.topPct).toBeGreaterThanOrEqual(0);
  });

  it("colliding labels resolve to zero overlap", () => {
    const placed = layoutLabels([
      { id: "a", name: "The Guild Quarter", xPct: 0.5, yPct: 0.3 },
      { id: "b", name: "The Thieves' Guild", xPct: 0.5, yPct: 0.3 },
      { id: "c", name: "The Fools' Guild", xPct: 0.51, yPct: 0.31 },
    ]);
    expect(placed).toHaveLength(3);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlapArea(placed[i]!, placed[j]!)).toBe(0);
      }
    }
  });

  it("edge anchors clamp into the frame; long names truncate", () => {
    const placed = layoutLabels([
      { id: "edge", name: "North Gate", xPct: 0.99, yPct: 0.01 },
      {
        id: "long",
        name: "The Extraordinarily Long Named University of Wizardry",
        xPct: 0.5,
        yPct: 0.5,
      },
    ]);
    for (const l of placed) {
      expect(l.leftPct).toBeGreaterThanOrEqual(0);
      expect(l.leftPct + l.wPct).toBeLessThanOrEqual(1);
      expect(l.topPct).toBeGreaterThanOrEqual(0);
      expect(l.topPct + l.hPct).toBeLessThanOrEqual(1);
    }
    expect(placed.find((l) => l.id === "long")!.name.endsWith("…")).toBe(true);
  });
});

describe("anchorsFromGeo", () => {
  it("projects frame coords to 0..1 and drops blanks + out-of-frame", () => {
    const frame = { x: 0, y: 0, w: 100, h: 60 };
    const anchors = anchorsFromGeo(
      [
        { id: "a", label: "Palace", pos: { x: 50, y: 30 } },
        { id: "b", label: "  ", pos: { x: 10, y: 10 } },
        { id: "c", label: "Far Away", pos: { x: 500, y: 30 } },
      ],
      frame,
    );
    expect(anchors).toEqual([{ id: "a", name: "Palace", xPct: 0.5, yPct: 0.5 }]);
  });
});
