import { describe, expect, it } from "vitest";

import { coachPreDefault, parseCoachFlag } from "./coach";

describe("parseCoachFlag", () => {
  it("reads explicit on/off, null for unset or junk", () => {
    expect(parseCoachFlag("1")).toBe(true);
    expect(parseCoachFlag("TRUE")).toBe(true);
    expect(parseCoachFlag("yes")).toBe(true);
    expect(parseCoachFlag("0")).toBe(false);
    expect(parseCoachFlag("false")).toBe(false);
    expect(parseCoachFlag("no")).toBe(false);
    expect(parseCoachFlag(null)).toBe(null);
    expect(parseCoachFlag(undefined)).toBe(null);
    expect(parseCoachFlag("")).toBe(null);
    expect(parseCoachFlag("maybe")).toBe(null);
  });
});

describe("coachPreDefault", () => {
  const base = { urlParam: null, envValue: null, hadPriorUse: false, dismissed: false };

  it("the URL ?coach= override wins over everything (demos / UX bench)", () => {
    expect(coachPreDefault({ ...base, urlParam: "1", envValue: "0", hadPriorUse: true })).toBe(true);
    expect(coachPreDefault({ ...base, urlParam: "0", hadPriorUse: false })).toBe(false);
  });

  it("an explicit env flag wins over the first-timer heuristic (back-compat opt-in/out)", () => {
    // a self-hoster who pinned it ON keeps it on even for a returning user
    expect(coachPreDefault({ ...base, envValue: "1", hadPriorUse: true })).toBe(true);
    // ...and one who pinned it OFF keeps it off even for a first-timer
    expect(coachPreDefault({ ...base, envValue: "0", hadPriorUse: false })).toBe(false);
  });

  it("with no override, shows ONCE for a genuine first-timer", () => {
    expect(coachPreDefault({ ...base, hadPriorUse: false, dismissed: false })).toBe(true);
  });

  it("with no override, a returning user is unchanged (off)", () => {
    expect(coachPreDefault({ ...base, hadPriorUse: true })).toBe(false);
  });

  it("with no override, a first-timer who dismissed it never sees it again", () => {
    expect(coachPreDefault({ ...base, hadPriorUse: false, dismissed: true })).toBe(false);
  });
});
