import { describe, expect, it } from "vitest";

import type { ViewVerdict } from "@openflipbook/config";

import { formatViewVerdict, verdictAxes, verdictBucket } from "./view-verdict";

const base: ViewVerdict = {
  same_place: 9.0,
  conformance: null,
  medium: 7.5,
  detail: null,
  interior: null,
  attempts: 1,
  accepted: true,
};

describe("view-verdict", () => {
  it("buckets accepted vs keep-best", () => {
    expect(verdictBucket(base)).toBe("verified");
    expect(verdictBucket({ ...base, accepted: false })).toBe("best_effort");
  });

  it("lists only the axes that ran — absent judges stay absent", () => {
    expect(verdictAxes(base)).toEqual(["same place 9.0/10", "medium 7.5/10"]);
  });

  it("verified copy leads with the claim", () => {
    expect(formatViewVerdict(base)).toBe(
      "arrival verified — same place 9.0/10 · medium 7.5/10 · 1 attempt",
    );
  });

  it("keep-best copy reads as honest best-effort, not an error", () => {
    const kept = { ...base, accepted: false, attempts: 2, same_place: 5.5 };
    expect(formatViewVerdict(kept)).toBe(
      "best of 2 attempts — same place 5.5/10 · medium 7.5/10 (gates not all met)",
    );
  });
});
