import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import FogMap from "./fog-map";

function geo(id: string, x: number, y: number): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 4,
    footprint: { w: 8, d: 6 },
    visual: "",
    state: {},
    confidence: 1,
    source: "derived",
    updated_at: "t",
  };
}

describe("FogMap", () => {
  it("burns one fog hole per known place and pads the frontier", () => {
    const { container } = render(
      <FogMap
        entities={[geo("a", 10, 10), geo("b", 60, 40)]}
        bounds={{ x: 0, y: 0, w: 100, h: 60 }}
      />
    );
    const svg = container.querySelector("svg")!;
    // 18% padding on the larger bound (100): viewBox starts at -18.
    expect(svg.getAttribute("viewBox")).toBe("-18 -18 136 96");
    expect(container.querySelectorAll("mask circle")).toHaveLength(2);
    expect(svg.getAttribute("aria-label")).toContain("2 known places");
  });

  it("renders nothing for a session with no world map", () => {
    const { container } = render(
      <FogMap entities={[]} bounds={{ x: 0, y: 0, w: 0, h: 0 }} />
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});
