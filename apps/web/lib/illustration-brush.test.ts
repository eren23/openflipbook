import { expect, it } from "vitest";
import { brushPixels, brushStrokes, type IllustrationBrushStroke } from "./illustration-brush";

const stroke: IllustrationBrushStroke = { operation: "paint", radius: 2, points: [[8, 8], [12, 8]] };
it("rasterizes round pixel-centre strokes identically and applies ordered erasure", () => {
  const mask = brushPixels([stroke, { operation: "erase", radius: 1, points: [[10, 8]] }], 32, 32);
  let count = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const dx = x < 8 ? 8 - x : x > 12 ? x - 12 : 0;
    const inside = dx * dx + (y - 8) ** 2 <= 4 && (x - 10) ** 2 + (y - 8) ** 2 > 1;
    expect(mask[y * 32 + x]).toBe(inside ? 255 : 0); count += inside ? 1 : 0;
  }
  expect(count).toBe(28);
  expect(brushPixels([{ operation: "erase", radius: 1, points: [[10, 8]] }, stroke], 32, 32).filter(Boolean)).toHaveLength(33);
});
it("clips brush coverage at image edges and retains explicit empty selections", () => {
  expect(brushPixels([{ operation: "paint", radius: 1, points: [[0, 0]] }], 32, 32).filter(Boolean)).toHaveLength(3);
  expect(brushPixels([], 32, 32).some(Boolean)).toBe(false);
  expect(brushStrokes(undefined, 32, 32)).toBeUndefined(); expect(brushStrokes([], 32, 32)).toEqual([]);
  const copied = brushStrokes([stroke], 32, 32)!; copied[0]!.points[0]![0] = 20; expect(stroke.points[0]![0]).toBe(8);
});
it("bounds dimensions, points, stroke count and raster work before allocating", () => {
  for (const value of [null, {}, [{ ...stroke, radius: 0 }], [{ ...stroke, radius: 65 }], [{ ...stroke, radius: 2.5 }], [{ ...stroke, operation: "replace" }], [{ ...stroke, extra: true }], [{ ...stroke, points: [] }], [{ ...stroke, points: [[32, 0]] }], [{ ...stroke, points: [[0.5, 0]] }], [{ ...stroke, points: Array(513).fill([0, 0]) }], Array(33).fill(stroke)]) expect(() => brushStrokes(value, 32, 32)).toThrow();
  expect(() => brushStrokes([{ ...stroke, radius: 64, points: Array.from({ length: 10 }, (_, i) => i % 2 ? [1023, 1023] : [0, 0]) }], 1024, 1024)).toThrow("too complex");
  expect(() => brushPixels([stroke], Infinity, 32)).toThrow("dimensions");
});
