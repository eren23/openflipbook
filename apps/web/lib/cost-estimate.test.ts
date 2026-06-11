// Pins the projection to docs/COSTS.md's headline per-operation numbers
// (the table under "What each operation costs"). If fal/OpenRouter prices
// move, update the doc AND the constants — this test is the drift alarm.
import { describe, expect, it } from "vitest";

import { type CostBundle, formatCostRange, projectCost } from "./cost-estimate";

const BALANCED: CostBundle = { tier: "balanced", maxAttempts: 2, verify: true };
const FAST: CostBundle = { tier: "fast", maxAttempts: 1, verify: false };
const QUALITY: CostBundle = { tier: "pro", maxAttempts: 3, verify: true };

describe("projectCost vs docs/COSTS.md", () => {
  it("balanced tap ≈ $0.16 (1 attempt) – $0.32 (2 attempts)", () => {
    const { low, high } = projectCost(BALANCED, "tap");
    expect(low).toBeCloseTo(0.16, 1);
    expect(high).toBeCloseTo(0.32, 1);
  });

  it("balanced mask edit ≈ $0.11 – $0.21", () => {
    const { low, high } = projectCost(BALANCED, "edit");
    expect(low).toBeCloseTo(0.11, 2);
    expect(high).toBeCloseTo(0.21, 2);
  });

  it("balanced fresh map ≈ $0.16, never looped", () => {
    const { low, high } = projectCost(BALANCED, "query");
    expect(low).toBeCloseTo(0.16, 2);
    expect(high).toBe(low);
  });

  it("fast un-judged tap ≈ $0.04–0.05 — the Fast preset's whole point", () => {
    const { low, high } = projectCost(FAST, "tap");
    expect(high).toBe(low);
    expect(low).toBeGreaterThan(0.039); // never cheaper than the image itself
    expect(low).toBeLessThan(0.05);
  });

  it("verify:false collapses the range even with retries configured", () => {
    const r = projectCost({ ...BALANCED, verify: false }, "tap");
    expect(r.high).toBe(r.low);
    expect(r.low).toBeLessThan(projectCost(BALANCED, "tap").low);
  });

  it("quality tap scales with attempts and the pro image price", () => {
    const { low, high } = projectCost(QUALITY, "tap");
    expect(low).toBeCloseTo(0.25, 1);
    expect(high).toBeGreaterThan(0.7); // 3 × $0.24 + the judges
  });

  it("clamps absurd attempt asks to the server cap", () => {
    const capped = projectCost({ ...BALANCED, maxAttempts: 99 }, "tap");
    expect(capped.high).toBe(
      projectCost({ ...BALANCED, maxAttempts: 4 }, "tap").high,
    );
  });
});

describe("formatCostRange", () => {
  it("renders a range and collapses points", () => {
    expect(formatCostRange({ low: 0.1635, high: 0.3195 })).toBe("$0.16–0.32");
    expect(formatCostRange({ low: 0.0465, high: 0.0465 })).toBe("$0.05");
  });
});
