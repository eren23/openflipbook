import { afterEach, describe, expect, it, vi } from "vitest";

import { envFlag } from "./env-flag";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("envFlag", () => {
  it("is true for each truthy token, case-insensitively", () => {
    for (const v of ["1", "true", "yes", "TRUE", "Yes", "tRuE"]) {
      vi.stubEnv("FLAG_X", v);
      expect(envFlag("FLAG_X")).toBe(true);
    }
  });

  it("is false for falsy / unrecognised values", () => {
    for (const v of ["0", "false", "no", "off", "", "2", "truthy"]) {
      vi.stubEnv("FLAG_X", v);
      expect(envFlag("FLAG_X")).toBe(false);
    }
  });

  it("defaults to false when the var is unset", () => {
    vi.stubEnv("FLAG_UNSET", "");
    expect(envFlag("FLAG_UNSET")).toBe(false);
    // A name that was never stubbed at all.
    expect(envFlag("FLAG_NEVER_DEFINED")).toBe(false);
  });
});
