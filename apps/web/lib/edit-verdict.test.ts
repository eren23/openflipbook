import { describe, expect, it } from "vitest";

import { formatEditVerdict } from "./edit-verdict";

describe("formatEditVerdict", () => {
  it("reports an accepted edit with its scores", () => {
    expect(
      formatEditVerdict({
        alignment: 9.0,
        medium: 10.0,
        outside_change: 0,
        attempts: 1,
        accepted: true,
      })
    ).toBe("edit verified 9.0/10 · medium 10.0/10 · 1 attempt");
  });

  it("pluralizes attempts and admits a kept-best fallback", () => {
    expect(
      formatEditVerdict({
        alignment: 5.5,
        medium: 8.0,
        outside_change: null,
        attempts: 2,
        accepted: false,
      })
    ).toBe("edit kept best of 2 attempts — verification gates not all met");
  });

  it("renders degraded (null) scores as an em dash", () => {
    expect(
      formatEditVerdict({
        alignment: 9.0,
        medium: null,
        outside_change: null,
        attempts: 1,
        accepted: true,
      })
    ).toBe("edit verified 9.0/10 · medium —/10 · 1 attempt");
  });
});
