import { describe, expect, it } from "vitest";

import {
  childrenOf,
  resolveAbsolutePos,
  siblingsOf,
  type FrameNode,
} from "./world-geometry";

// Nested frames: the Unseen University is a sub-world at city (30,18); its
// sub-entities (Tower of Art, Library, Great Hall) live in ITS local frame.
const CITY: FrameNode[] = [
  { id: "uu", parent_id: null, pos: { x: 30, y: 18 } },
  { id: "palace", parent_id: null, pos: { x: 14, y: 35 } },
  { id: "tower", parent_id: "uu", pos: { x: -8, y: -1 } }, // local to uu
  { id: "library", parent_id: "uu", pos: { x: 6, y: 16 } },
  { id: "hall", parent_id: "uu", pos: { x: 8, y: 0 } },
];

describe("nested frames", () => {
  it("childrenOf returns a place's sub-entities, stable-sorted", () => {
    expect(childrenOf(CITY, "uu").map((g) => g.id)).toEqual([
      "hall",
      "library",
      "tower",
    ]);
    expect(childrenOf(CITY, "palace")).toEqual([]);
  });

  it("siblingsOf returns the frame-mates an edit ripples to", () => {
    // Moving the Tower of Art → its University frame-mates are the blast radius.
    expect(siblingsOf(CITY, "tower").map((g) => g.id).sort()).toEqual([
      "hall",
      "library",
    ]);
    // Top-level entities are each other's siblings (the city frame).
    expect(siblingsOf(CITY, "uu").map((g) => g.id)).toEqual(["palace"]);
  });

  it("resolveAbsolutePos walks the parent chain (local → world)", () => {
    const byId = new Map(CITY.map((g) => [g.id, g]));
    // Top-level: absolute == local.
    expect(resolveAbsolutePos("uu", byId)).toEqual({ x: 30, y: 18 });
    // Child: parent (30,18) + local (-8,-1) = (22,17) — the Tower of Art's
    // real spot on the city map, derived from its place-local position.
    expect(resolveAbsolutePos("tower", byId)).toEqual({ x: 22, y: 17 });
    expect(resolveAbsolutePos("library", byId)).toEqual({ x: 36, y: 34 });
  });

  it("resolveAbsolutePos is cycle-guarded and null-safe", () => {
    const cyclic = new Map<string, FrameNode>([
      ["a", { id: "a", parent_id: "b", pos: { x: 1, y: 1 } }],
      ["b", { id: "b", parent_id: "a", pos: { x: 2, y: 2 } }],
    ]);
    // Sums each node once, then stops — no infinite loop.
    expect(resolveAbsolutePos("a", cyclic)).toEqual({ x: 3, y: 3 });
    expect(resolveAbsolutePos("missing", cyclic)).toBeNull();
  });
});
