import { describe, expect, it } from "vitest";

import { buildOutwardContext } from "./outward-context";

describe("buildOutwardContext", () => {
  it("uses extracted map names instead of a generic upload title", () => {
    const ctx = buildOutwardContext({
      nodeId: "root",
      title: "Uploaded image",
      query: "Uploaded image",
      geos: [
        { label: "Ankh-Morpork", parent_id: null },
        { label: "Tower of Art", parent_id: "geo_uu" },
      ],
      entities: [
        {
          name: "The Mended Drum",
          kind: "place",
          appearance: "low tavern south of the river near The Shades",
          facts: ["Sits in Morpork near The Shades"],
          appears_on_node_ids: ["root"],
          first_seen_node_id: "root",
          last_seen_node_id: "root",
        },
      ],
    });

    expect(ctx).toContain("Ankh-Morpork");
    expect(ctx).toContain("The Mended Drum");
    expect(ctx).not.toContain("Uploaded image");
    expect(ctx).not.toContain("Tower of Art");
  });

  it("returns null when only placeholder labels are available", () => {
    expect(
      buildOutwardContext({
        nodeId: "root",
        title: "Uploaded image",
        query: "Uploaded image",
        geos: [],
        entities: [],
      }),
    ).toBeNull();
  });
});
