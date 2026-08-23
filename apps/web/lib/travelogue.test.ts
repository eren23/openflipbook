import { describe, expect, it } from "vitest";

import { buildTravelogue, type TravelogueNode } from "./travelogue";

function n(
  id: string,
  parent: string | null,
  created: string,
  relation: TravelogueNode["relation"] = parent ? "descend" : null
): TravelogueNode {
  return { id, parentId: parent, title: `T-${id}`, createdAt: created, relation };
}

describe("buildTravelogue", () => {
  it("retells the graph in creation order with the moves actually made", () => {
    const entries = buildTravelogue([
      n("kid", "root", "2026-01-02"),
      n("root", null, "2026-01-01"),
      n("peer", "root", "2026-01-03", "expand"),
      n("up", "kid", "2026-01-04", "ascend"),
      n("fix", "kid", "2026-01-05", "edit"),
    ]);
    expect(entries.map((e) => e.line)).toEqual([
      "arrived in T-root",
      "entered T-kid from T-root",
      "drifted over to T-peer from T-root",
      "rose out to T-up from T-kid",
      "reshaped T-fix from T-kid",
    ]);
  });

  it("an orphan (parent outside the window) reads as an arrival, not a crash", () => {
    const [entry] = buildTravelogue([n("lost", "gone", "2026-01-01")]);
    expect(entry!.line).toBe("arrived in T-lost");
  });
});
