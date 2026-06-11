import { describe, expect, it } from "vitest";

import {
  buildSegments,
  marksForEndReportedStage,
  type WaterfallMark,
} from "./waterfall-segments";

describe("buildSegments", () => {
  it("start-marks run until the next mark; the active tail grows to now", () => {
    const marks: WaterfallMark[] = [
      { stage: "request", t: 1000 },
      { stage: "planning", t: 1500 },
      { stage: "generating_image", t: 2000 },
    ];
    const segs = buildSegments(marks, 1000, "generating_image", 5000);
    expect(segs).toEqual([
      { stage: "request", start: 0, end: 500 },
      { stage: "planning", start: 500, end: 1000 },
      { stage: "generating_image", start: 1000, end: 4000 },
    ]);
  });

  it("explicit ends beat next-mark inference (the off-by-one fix)", () => {
    const marks: WaterfallMark[] = [
      { stage: "final", t: 2000 },
      { stage: "decode", t: 2010, end: 2200 },
      { stage: "morph", t: 2200, end: 2800 },
    ];
    const segs = buildSegments(marks, 1000, null, 9999);
    expect(segs.find((s) => s.stage === "decode")).toEqual({
      stage: "decode",
      start: 1010,
      end: 1200,
    });
    expect(segs.find((s) => s.stage === "morph")).toEqual({
      stage: "morph",
      start: 1200,
      end: 1800,
    });
  });

  it("dead time between an explicit end and the next mark reads as idle", () => {
    const marks: WaterfallMark[] = [
      { stage: "decode", t: 2000, end: 2100 },
      { stage: "morph", t: 9000, end: 9600 },
    ];
    const segs = buildSegments(marks, 1000, null, 0);
    expect(segs.map((s) => s.stage)).toEqual(["decode", "idle", "morph"]);
    expect(segs[1]).toEqual({ stage: "idle", start: 1100, end: 8000 });
  });
});

describe("marksForEndReportedStage", () => {
  it("reconstructs the stage start from its measured duration", () => {
    const prev: WaterfallMark[] = [{ stage: "final", t: 2000 }];
    const out = marksForEndReportedStage(prev, "decode", 2005, 180);
    expect(out[out.length - 1]).toEqual({
      stage: "decode",
      t: 2005,
      end: 2185,
    });
    expect(out).toHaveLength(2); // 5ms gap -> no idle inserted
  });

  it("the 184813ms incident: a deferred decode surfaces as idle, not decode", () => {
    // Tab hidden through a 3-minute pro render: the decode promise resolved
    // 184s after the final frame, with the decode itself taking ~190ms.
    const prev: WaterfallMark[] = [{ stage: "final", t: 2000 }];
    const out = marksForEndReportedStage(prev, "decode", 186_813, 190);
    expect(out.map((m) => m.stage)).toEqual(["final", "idle", "decode"]);
    expect(out[1]).toEqual({ stage: "idle", t: 2000, end: 186_813 });
    expect(out[2]).toEqual({ stage: "decode", t: 186_813, end: 187_003 });
  });
});
