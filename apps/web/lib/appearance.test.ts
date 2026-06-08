import { describe, expect, it } from "vitest";

import { viewNeutralAppearance } from "./appearance";

describe("viewNeutralAppearance", () => {
  it("drops a top-down clause but keeps the identity", () => {
    expect(
      viewNeutralAppearance(
        "A massive circular stone spire seen from directly above, showing concentric rings of ancient masonry and weathered moss-covered stone.",
      ),
    ).toBe(
      "A massive circular stone spire, showing concentric rings of ancient masonry and weathered moss-covered stone.",
    );
  });

  it("strips the angle adjective but keeps the noun", () => {
    expect(viewNeutralAppearance("A top-down map of the city")).toBe(
      "A map of the city",
    );
    const be = viewNeutralAppearance("A bird's-eye view of gabled rooftops");
    expect(be).toContain("gabled rooftops");
    expect(be.toLowerCase()).not.toContain("bird");
  });

  it("removes assorted view phrases", () => {
    for (const [input, has] of [
      ["a tower viewed from above", "tower"],
      ["the hall at street-level", "hall"],
      ["an aerial sketch of the docks", "sketch of the docks"],
      ["a close-up of the doors", "of the doors"],
    ] as const) {
      const out = viewNeutralAppearance(input);
      expect(out).toContain(has);
      expect(out.toLowerCase()).not.toMatch(
        /from above|street-level|aerial|close-up/,
      );
    }
  });

  it("is null/empty safe", () => {
    expect(viewNeutralAppearance(null)).toBe("");
    expect(viewNeutralAppearance(undefined)).toBe("");
    expect(viewNeutralAppearance("   ")).toBe("");
  });

  it("leaves an already-neutral descriptor unchanged", () => {
    const s = "A grand white stone palace with two square towers.";
    expect(viewNeutralAppearance(s)).toBe(s);
  });
});
