import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Entity } from "@openflipbook/config";

import GeometryOverlay from "./GeometryOverlay";

function ent(
  id: string,
  name: string,
  bboxes: Entity["appearance_bboxes"],
): Pick<Entity, "id" | "name" | "kind" | "appearance_bboxes"> {
  return { id, name, kind: "place", appearance_bboxes: bboxes };
}

describe("GeometryOverlay", () => {
  it("draws a box per entity that has a bbox for this node", () => {
    render(
      <GeometryOverlay
        nodeId="n1"
        entities={[
          ent("a", "Unseen University", { n1: { x_pct: 0.4, y_pct: 0.25, w_pct: 0.2, h_pct: 0.3 } }),
          ent("b", "The Shades", { n2: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.1, h_pct: 0.1 } }), // other node
          ent("c", "River Ankh", {}), // no bbox
        ]}
      />,
    );
    const boxes = screen.getAllByTestId("geo-box");
    expect(boxes).toHaveLength(1); // only "a" has a bbox on n1
    expect(screen.getByText("Unseen University")).toBeTruthy();
    // positioned by % from the normalized bbox
    expect(boxes[0]!.style.left).toBe("40%");
    expect(boxes[0]!.style.width).toBe("20%");
  });

  it("culls boxes that aren't really in this frame (off-centre / backdrop)", () => {
    render(
      <GeometryOverlay
        nodeId="n1"
        entities={[
          ent("in", "In frame", { n1: { x_pct: 0.4, y_pct: 0.4, w_pct: 0.2, h_pct: 0.2 } }),
          // centre at (1.1, 0.5) — off the right edge → dropped.
          ent("off", "Off frame", { n1: { x_pct: 1.05, y_pct: 0.45, w_pct: 0.1, h_pct: 0.1 } }),
          // covers ~72% of the image → a mislocalized backdrop → dropped.
          ent("backdrop", "Whole map", { n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.9, h_pct: 0.8 } }),
        ]}
      />,
    );
    const boxes = screen.getAllByTestId("geo-box");
    expect(boxes).toHaveLength(1);
    expect(screen.getByText("In frame")).toBeTruthy();
  });

  it("scopes to the current frame: only the place's own children draw", () => {
    render(
      <GeometryOverlay
        nodeId="n1"
        entities={[
          ent("tower", "Tower of Art", { n1: { x_pct: 0.4, y_pct: 0.4, w_pct: 0.2, h_pct: 0.2 } }),
          // a CITY landmark that leaked a bbox onto this interior node — filtered
          // out because it isn't a child of the place you're inside.
          ent("palace", "Patrician's Palace", { n1: { x_pct: 0.6, y_pct: 0.5, w_pct: 0.15, h_pct: 0.15 } }),
        ]}
        allowedEntityIds={new Set(["tower"])}
      />,
    );
    expect(screen.getAllByTestId("geo-box")).toHaveLength(1);
    expect(screen.getByText("Tower of Art")).toBeTruthy();
    expect(screen.queryByText("Patrician's Palace")).toBeNull();
  });

  it("shows the empty note when nothing is localized on this node", () => {
    render(<GeometryOverlay nodeId="n1" entities={[ent("c", "River Ankh", {})]} />);
    expect(screen.queryAllByTestId("geo-box")).toHaveLength(0);
    expect(screen.getByText(/no localized geometry/i)).toBeTruthy();
  });
});
