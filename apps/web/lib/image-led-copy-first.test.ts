import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { copyFirstDepth, copyFirstParameters, copyFirstWarp } from "./image-led-copy-first";

const dir = path.join(__dirname, "../tests/fixtures/copy-first");
const raw = async (name: string, channels: 1 | 3) => { const { data, info } = await sharp(path.join(dir, name)).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data: channels === 3 ? new Uint8Array(data) : Uint8Array.from({ length: info.width * info.height }, (_, i) => data[i * info.channels]!), w: info.width, h: info.height }; };
const step = (tz: number, yaw: number) => ({ tz, yaw_degrees: yaw, pitch_degrees: 0, offset: 0.4, fov_degrees: 60 });

describe("copy-first warp", () => {
  it("keeps every pixel for a zero step and a flat depth", () => {
    const rgb = Uint8Array.from({ length: 8 * 6 * 3 }, (_, i) => (i * 37) % 256), z = copyFirstDepth(new Uint8Array(48).fill(128), 0.4);
    expect([...z].every(v => v === 1)).toBe(true);
    const out = copyFirstWarp(rgb, z, 8, 6, step(0, 0));
    expect(out.holes).toBe(0); expect([...out.rgb]).toEqual([...rgb]);
  });

  it("stretches depth between the 2nd and 98th percentiles and divides by the median", () => {
    const z = copyFirstDepth(Uint8Array.from({ length: 101 }, (_, i) => Math.round(i * 2.55)), 0.4);
    expect(z[50]).toBeCloseTo(1, 6); expect(z[0]).toBeGreaterThan(z[100]!); // near = bright = smaller depth
  });

  it("matches the research warp.py golden output", async () => {
    const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as { cases: Record<string, { tz: number; yaw_degrees: number; holes: number }> };
    const prior = await raw("prior.png", 3), depth = await raw("depth.png", 1), z = copyFirstDepth(depth.data, 0.4);
    for (const [name, c] of Object.entries(expected.cases)) {
      const out = copyFirstWarp(prior.data, z, prior.w, prior.h, step(c.tz, c.yaw_degrees)), want = await raw(`${name}.png`, 3), holes = await raw(`${name}-holes.png`, 1);
      expect(Math.abs(out.holes - c.holes)).toBeLessThanOrEqual(Math.max(2, c.holes * 0.02));
      let sum = 0, count = 0, over = 0;
      for (let i = 0; i < prior.w * prior.h; i++) { if (holes.data[i]) continue; for (let k = 0; k < 3; k++) { const d = Math.abs(out.rgb[i * 3 + k]! - want.data[i * 3 + k]!); sum += d; count++; if (d > 16) over++; } }
      expect(sum / count).toBeLessThan(1); expect(over / count).toBeLessThan(0.01);
    }
  });

  it("refuses mismatched picture and depth sizes", () => {
    expect(() => copyFirstWarp(new Uint8Array(12), new Float64Array(3), 2, 2, step(0, 0))).toThrow(/sizes differ/);
  });
});

describe("copy-first profile", () => {
  const good = { tz: 0.1, max_turn_degrees: 3, pitch_degrees: 0, offset: 0.4, fov_degrees: 60, bg_fill: true, warp_version: "copy-first-warp-v1" };
  it("accepts only the closed backend profile", () => {
    expect(copyFirstParameters(good)).toEqual(good);
    for (const bad of [{ ...good, tz: 0 }, { ...good, tz: 0.31 }, { ...good, max_turn_degrees: 11 }, { ...good, offset: 0.1 }, { ...good, warp_version: "v2" }, { ...good, extra: 1 }, {}, null])
      expect(() => copyFirstParameters(bad)).toThrow(/Unknown copy-first profile/);
  });
});
