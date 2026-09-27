import { describe, expect, it } from "vitest";
import { canvasBox, CONTROLLED_IDS, controlledAssetPath, expectedLandmark, sampleTime } from "./controlled-study";
import { sampleReframe, type ReframePlan } from "./spatial-transition";

describe("controlled study assets and geometry", () => {
  it("only serves the fixed pilot artifacts", () => {
    for (const id of CONTROLLED_IDS) for (const suffix of [".mp4", "-receipt.json", "-contact.jpg"]) expect(controlledAssetPath(`controlled-${id}${suffix}`)).toContain("reports/controlled-lighthouse/");
    for (const file of ["controlled-summary.json", "controlled-reference.mp4", "controlled-edges.mp4", "controlled-first.png", "controlled-last.png"]) expect(controlledAssetPath(file)).not.toBeNull();
    for (const file of ["../.env", "controlled-../.env", "__proto__", "constructor", "controlled-unknown.mp4", "controlled-summary.json/../.env"]) expect(controlledAssetPath(file)).toBeNull();
  });
  it("matches the production affine sampler without using production crop selection", () => {
    const crop: [number, number, number] = [0, .029, .528];
    const landmark: [number, number, number, number] = [.082, .074, .127, .438];
    const plan = { fraction: crop[2], crop: { x: crop[0], y: crop[1] } } as ReframePlan;
    for (let i = 0; i <= 120; i++) {
      const m = sampleReframe(plan, i / 120);
      const box = expectedLandmark(crop, landmark, i / 120);
      expect(box[0]).toBeCloseTo(landmark[0] * m.scale + m.x, 10);
      expect(box[1]).toBeCloseTo(landmark[1] * m.scale + m.y, 10);
      expect(box[0]).toBeGreaterThanOrEqual(0); expect(box[0] + box[2]).toBeLessThanOrEqual(1);
      expect(box[1]).toBeGreaterThanOrEqual(0); expect(box[1] + box[3]).toBeLessThanOrEqual(1);
    }
  });
  it("accounts for letterboxing and targets the last decoded frame", () => {
    expect(canvasBox([0, 0, 1, 1], [10, 0, 1260, 704], [1280, 704])).toEqual([10 / 1280, 0, 1260 / 1280, 1]);
    expect(sampleTime(1, 121 / 24, 121)).toBeCloseTo(5);
    expect(sampleTime(0, 6, 144)).toBe(0);
    expect(sampleTime(2, 6, 144)).toBeCloseTo(143 / 24);
  });
});
