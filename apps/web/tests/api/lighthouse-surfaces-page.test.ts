import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/app/dev/spatial-transitions/lighthouse-surfaces/study", () => ({ default: () => null }));
import Page from "@/app/dev/spatial-transitions/lighthouse-surfaces/page";
afterEach(() => vi.unstubAllEnvs());
it.each([["production", "1", false], ["development", "0", false], ["development", "1", true]])("gates surfaces in %s / %s", (mode, flag, visible) => {
  vi.stubEnv("NODE_ENV", mode); vi.stubEnv("SPATIAL_STUDY", flag);
  if (visible) expect(Page()).toBeTruthy(); else expect(Page).toThrow("NEXT_NOT_FOUND");
});
