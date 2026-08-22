import { describe, expect, it } from "vitest";

import { buildTour, type TourNode } from "./tour";

function n(
  id: string,
  parent: string | null,
  created: string,
  over: Partial<TourNode> = {}
): TourNode {
  return {
    id,
    parent_id: parent,
    page_title: id,
    image_url: `https://r2/${id}.jpg`,
    click_in_parent: parent ? { x_pct: 0.5, y_pct: 0.4 } : null,
    relation: parent ? "descend" : null,
    created_at: created,
    ...over,
  };
}

describe("buildTour", () => {
  it("walks depth-first in creation order; descend edges dive at the tap point", () => {
    const steps = buildTour([
      n("root", null, "2026-01-01"),
      n("b", "root", "2026-01-03"),
      n("a", "root", "2026-01-02"),
      n("a1", "a", "2026-01-04"),
    ]);
    expect(steps.map((s) => s.node.id)).toEqual(["root", "a", "a1", "b"]);
    // root -> a is a child edge with a tap point: the camera dives there.
    expect(steps[0]).toMatchObject({
      exit: "dive",
      target: { x_pct: 0.5, y_pct: 0.4 },
    });
    // a1 -> b is a backtrack across the tree: plain cut.
    expect(steps[2]!.exit).toBe("cut");
    expect(steps[3]!.exit).toBe("end");
  });

  it("cuts (never dives) when a child has no recorded tap point", () => {
    const steps = buildTour([
      n("root", null, "2026-01-01"),
      n("kid", "root", "2026-01-02", { click_in_parent: null }),
    ]);
    expect(steps[0]!.exit).toBe("cut");
  });

  it("skips edit revisions and tours orphans as roots", () => {
    const steps = buildTour([
      n("root", null, "2026-01-01"),
      n("fix", "root", "2026-01-02", { relation: "edit" }),
      n("lost", "gone-parent", "2026-01-03"),
    ]);
    expect(steps.map((s) => s.node.id)).toEqual(["root", "lost"]);
  });

  it("a single page is just an end card", () => {
    expect(buildTour([n("solo", null, "2026-01-01")])).toEqual([
      { node: expect.objectContaining({ id: "solo" }), exit: "end", target: null },
    ]);
  });
});
