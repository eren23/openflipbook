import { describe, expect, it } from "vitest";

import { isSafeId } from "./ids";

describe("isSafeId (route-boundary id guard)", () => {
  it("accepts the ids the app mints", () => {
    expect(isSafeId("session_3f2a9c10-1b2c-4d5e-8f90-abcdef012345")).toBe(true);
    expect(isSafeId("3f2a9c10-1b2c-4d5e-8f90-abcdef012345")).toBe(true);
    expect(isSafeId("geo_uu")).toBe(true);
  });

  it("rejects Mongo-key hazards and junk", () => {
    expect(isSafeId("a.b")).toBe(false); // dotted path
    expect(isSafeId("$where")).toBe(false); // operator
    expect(isSafeId("a/b")).toBe(false);
    expect(isSafeId("")).toBe(false);
    expect(isSafeId("x".repeat(129))).toBe(false); // oversize
    expect(isSafeId(null)).toBe(false);
    expect(isSafeId(42)).toBe(false);
  });
});
