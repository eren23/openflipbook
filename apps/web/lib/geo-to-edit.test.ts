import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import { applyPlanInstruction, compassFor } from "./geo-to-edit";

const FRAME = { w: 100, h: 60 };

function _geo(id: string, label: string, height = 10): WorldEntityGeo {
  return {
    id,
    entity_id: null,
    kind: "place",
    label,
    pos: { x: 50, y: 30 },
    height,
    footprint: { w: 8, d: 8 },
  } as WorldEntityGeo;
}

const ENTITIES = [_geo("g1", "lighthouse"), _geo("g2", "stone castle", 15)];

describe("compassFor", () => {
  it("names the cardinal directions (+x east, +y south)", () => {
    expect(compassFor(0, -10)).toBe("north");
    expect(compassFor(10, 0)).toBe("east");
    expect(compassFor(-10, 10)).toBe("south-west");
  });

  it("drops a noise minor axis", () => {
    expect(compassFor(10, 1)).toBe("east");
  });
});

describe("applyPlanInstruction", () => {
  it("phrases a move with magnitude and direction", () => {
    const text = applyPlanInstruction(
      [{ op: "move", target: "g1", dx: 0, dy: -40 }],
      ENTITIES,
      FRAME
    );
    expect(text).toContain("move the lighthouse far north");
    expect(text).toContain("Keep the existing scene");
    expect(text.endsWith(".")).toBe(true);
  });

  it("phrases small moves as slight", () => {
    const text = applyPlanInstruction(
      [{ op: "move", target: "g1", dx: 4, dy: 0 }],
      ENTITIES,
      FRAME
    );
    expect(text).toContain("move the lighthouse slightly east");
  });

  it("phrases add with frame-third bins and remove by label", () => {
    const text = applyPlanInstruction(
      [
        { op: "add", label: "windmill", pos: { x: 90, y: 10 } },
        { op: "remove", target: "g2" },
      ],
      ENTITIES,
      FRAME
    );
    expect(text).toContain("add a windmill on the right, toward the top of the frame");
    expect(text).toContain("remove the stone castle");
    expect(text).toContain("; ");
  });

  it("compares set_height against the current entity", () => {
    const taller = applyPlanInstruction(
      [{ op: "set_height", target: "g2", height: 30 }],
      ENTITIES,
      FRAME
    );
    expect(taller).toContain("make the stone castle taller");
    const shorter = applyPlanInstruction(
      [{ op: "set_height", target: "g2", height: 5 }],
      ENTITIES,
      FRAME
    );
    expect(shorter).toContain("make the stone castle shorter");
  });

  it("falls back to the raw target id when the entity is unknown", () => {
    const text = applyPlanInstruction(
      [{ op: "remove", target: "ghost-9" }],
      ENTITIES,
      FRAME
    );
    expect(text).toContain("remove the ghost-9");
  });

  it("returns empty for an empty plan", () => {
    expect(applyPlanInstruction([], ENTITIES, FRAME)).toBe("");
  });
});
