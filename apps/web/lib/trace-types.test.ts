import { describe, expect, test } from "vitest";

import type { BackendSpan } from "./trace-types";
import {
  packSpansIntoRows,
  spanCategory,
  summarizeCategories,
} from "./trace-types";

function makeSpan(
  name: string,
  start_ms: number,
  end_ms: number,
  level: BackendSpan["level"] = "info"
): BackendSpan {
  return {
    name,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    level,
  };
}

describe("spanCategory", () => {
  test("vlm prefix → blue", () => {
    expect(spanCategory("vlm.click_to_subject").label).toBe("vlm");
    expect(spanCategory("vlm.click_to_subject").color).toBe("#3b82f6");
  });

  test("plan and planner both match planner", () => {
    expect(spanCategory("plan.page").label).toBe("planner");
    expect(spanCategory("planner.compose").label).toBe("planner");
  });

  test("image-gen prefixes", () => {
    expect(spanCategory("image.generate").label).toBe("image-gen");
    expect(spanCategory("image_gen.fast_tier").label).toBe("image-gen");
  });

  test("persist family covers r2, mongo, save, store", () => {
    for (const name of ["r2.upload", "mongo.insert", "save.node", "store.entity"]) {
      expect(spanCategory(name).label).toBe("persist");
    }
  });

  test("unknown prefix falls back to other", () => {
    expect(spanCategory("mystery.span").label).toBe("other");
    expect(spanCategory("").label).toBe("other");
  });
});

describe("packSpansIntoRows", () => {
  test("non-overlapping spans share row 0", () => {
    const packed = packSpansIntoRows([
      makeSpan("a", 0, 10),
      makeSpan("b", 10, 20),
      makeSpan("c", 25, 30),
    ]);
    expect(packed.map((p) => p.row)).toEqual([0, 0, 0]);
  });

  test("overlapping spans stack onto separate rows", () => {
    const packed = packSpansIntoRows([
      makeSpan("a", 0, 50),
      makeSpan("b", 10, 30),
      makeSpan("c", 20, 40),
    ]);
    const rowOf = (n: string) => packed.find((p) => p.name === n)!.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1);
    expect(rowOf("c")).toBe(2);
  });

  test("freed row is reused once span ends", () => {
    const packed = packSpansIntoRows([
      makeSpan("a", 0, 10),
      makeSpan("b", 5, 20),
      makeSpan("c", 11, 25),
    ]);
    const rowOf = (n: string) => packed.find((p) => p.name === n)!.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1);
    // c starts at 11 — row 0 is free since a ended at 10
    expect(rowOf("c")).toBe(0);
  });

  test("preserves input span data on the packed span", () => {
    const [first] = packSpansIntoRows([makeSpan("x", 0, 10, "error")]);
    expect(first).toBeDefined();
    expect(first?.level).toBe("error");
    expect(first?.duration_ms).toBe(10);
  });

  test("empty input → empty output", () => {
    expect(packSpansIntoRows([])).toEqual([]);
  });
});

describe("summarizeCategories", () => {
  test("groups by label and sums duration_ms", () => {
    const spans = [
      makeSpan("vlm.click", 0, 100),
      makeSpan("vlm.precompute", 100, 250),
      makeSpan("plan.page", 250, 400),
      makeSpan("image.gen", 400, 1500),
    ];
    const [first, second, third, ...rest] = summarizeCategories(spans);
    expect(rest).toEqual([]);
    // sorted descending by totalMs
    expect(first).toMatchObject({ label: "image-gen", totalMs: 1100 });
    expect(second).toMatchObject({ label: "vlm", totalMs: 250 });
    expect(third).toMatchObject({ label: "planner", totalMs: 150 });
  });

  test("empty input → empty array", () => {
    expect(summarizeCategories([])).toEqual([]);
  });
});
