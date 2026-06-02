import { describe, expect, it } from "vitest";

import { lodOpacity, scaleStep } from "./world-layout";

/**
 * M3 phase 3 — level-of-detail zoom reveal. `scaleStep` composes the scale
 * buckets into an integer ladder; `lodOpacity` maps (scale-level, camera zoom)
 * to a visibility factor so small things reveal when you zoom in and big
 * things when you zoom out. Pure functions so the band math is regression-
 * tested without rendering the atlas.
 */

describe("scaleStep — scale buckets compose into an integer ladder", () => {
  it("maps container/peer/component to +1/0/-1, defaulting to 0", () => {
    expect(scaleStep("container")).toBe(1);
    expect(scaleStep("peer")).toBe(0);
    expect(scaleStep("component")).toBe(-1);
    expect(scaleStep(undefined)).toBe(0); // scale-less = peer (back-compat)
  });
});

describe("lodOpacity — zoom-reveal band", () => {
  const FIT = 0.1; // arbitrary fit-all reference zoom

  it("shows a peer (level 0) fully at the fit-all zoom", () => {
    expect(lodOpacity(0, FIT, FIT)).toBe(1);
  });

  it("reveals containers (level +1) when zoomed OUT, fades them when zoomed IN", () => {
    const zoomedOut = lodOpacity(1, FIT / 4, FIT);
    const zoomedIn = lodOpacity(1, FIT * 4, FIT);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it("reveals components (level -1) when zoomed IN, fades them when zoomed OUT", () => {
    const zoomedIn = lodOpacity(-1, FIT * 4, FIT);
    const zoomedOut = lodOpacity(-1, FIT / 4, FIT);
    expect(zoomedIn).toBeGreaterThan(zoomedOut);
  });

  it("never fully hides a node (keeps a legible floor) and never exceeds 1", () => {
    const wayOutOfBand = lodOpacity(3, FIT * 64, FIT);
    expect(wayOutOfBand).toBeGreaterThan(0);
    expect(wayOutOfBand).toBeLessThan(0.3);
    expect(lodOpacity(0, FIT, FIT)).toBeLessThanOrEqual(1);
  });
});
