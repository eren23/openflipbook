import { describe, expect, it } from "vitest";

import { buildBreadcrumb } from "./breadcrumb";

const items = [
  { nodeId: "city", parentId: null, title: "A Map of Ankh-Morpork" },
  { nodeId: "uu", parentId: "city", title: "Unseen University" },
  { nodeId: "tower", parentId: "uu", title: "The Tower of Art" },
  { nodeId: "other", parentId: "city", title: "The Shades" },
];

describe("buildBreadcrumb", () => {
  it("walks the parent chain root → current", () => {
    expect(buildBreadcrumb("tower", items).map((c) => c.title)).toEqual([
      "A Map of Ankh-Morpork",
      "Unseen University",
      "The Tower of Art",
    ]);
  });

  it("a root node is a single crumb", () => {
    expect(buildBreadcrumb("city", items).map((c) => c.nodeId)).toEqual(["city"]);
  });

  it("stops at the first unloaded ancestor (continued session)", () => {
    const partial = [{ nodeId: "tower", parentId: "uu", title: "The Tower of Art" }];
    expect(buildBreadcrumb("tower", partial).map((c) => c.nodeId)).toEqual(["tower"]);
  });

  it("is cycle-guarded", () => {
    const cyclic = [
      { nodeId: "a", parentId: "b", title: "A" },
      { nodeId: "b", parentId: "a", title: "B" },
    ];
    expect(buildBreadcrumb("a", cyclic).length).toBe(2); // each visited once
  });

  it("falls back to 'Untitled' and returns [] for no current node", () => {
    expect(buildBreadcrumb(null, items)).toEqual([]);
    expect(
      buildBreadcrumb("x", [{ nodeId: "x", parentId: null, title: "  " }])[0]!.title,
    ).toBe("Untitled");
  });
});
