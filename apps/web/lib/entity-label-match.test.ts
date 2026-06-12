import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import { matchEntityLabel } from "./entity-label-match";

function geo(
  id: string,
  label: string,
  opts: Partial<WorldEntityGeo> = {},
): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label,
    pos: { x: 50, y: 30 },
    height: 4,
    footprint: { w: 8, d: 8 },
    visual: "",
    state: {},
    confidence: 1,
    source: "user",
    updated_at: "t",
    ...opts,
  };
}

describe("matchEntityLabel (lettering tap → the named place)", () => {
  const city = [
    geo("palace", "Patrician's Palace"),
    geo("river", "The River Ankh"),
    geo("uni", "Unseen University"),
  ];

  it("exact label (case/punctuation-insensitive)", () => {
    expect(matchEntityLabel("patricians palace", city)?.id).toBe("palace");
    expect(matchEntityLabel("THE RIVER ANKH", city)?.id).toBe("river");
  });

  it("subject contains the label — the VLM padded the lettering read", () => {
    expect(
      matchEntityLabel("The Patrician's Palace and its gardens", city)?.id,
    ).toBe("palace");
  });

  it("subject contained by the label — a clipped lettering read", () => {
    expect(matchEntityLabel("the river", city)?.id).toBe("river");
  });

  it("fuzzy bigram net for near-misses", () => {
    expect(matchEntityLabel("patrician palace", city)?.id).toBe("palace");
  });

  it("no plausible match → null (the classic tap must stand)", () => {
    expect(matchEntityLabel("a mysterious stranger", city)).toBeNull();
    expect(matchEntityLabel("", city)).toBeNull();
    expect(matchEntityLabel("   ", city)).toBeNull();
  });

  it("places outrank non-places at equal strength", () => {
    const entities = [
      geo("vetinari", "The Patrician", { kind: "person" }),
      geo("palace2", "The Patrician", { kind: "place" }),
    ];
    expect(matchEntityLabel("the patrician", entities)?.id).toBe("palace2");
  });

  it("entities with blank labels never match", () => {
    expect(matchEntityLabel("anything", [geo("x", "  ")])).toBeNull();
  });
});
