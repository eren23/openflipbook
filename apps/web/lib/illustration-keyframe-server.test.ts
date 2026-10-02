import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { finishKeyframe, type KeyframeChain, type KeyframePasses } from "./illustration-keyframe-server";

const S = 64, f = 1 / Math.tan(25 * Math.PI / 180);
const png = (rgba: Uint8Array, channels: 1 | 4 = 4) => sharp(Buffer.from(rgba), { raw: { width: S, height: S, channels } }).png().toBuffer();
const solid = (rgb: number[]) => new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]!));
// Camera at (x, 0, 0) facing a wall 10 m away that fills the frame (depth byte 208 = 10.03 m).
const view = (x: number) => ({ width: S, height: S, depth: { near: 1, far: 50 },
  camera: { projection: "perspective" as const, world_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
    projection_matrix: [f, 0, 0, 0, 0, f, 0, 0, 0, 0, -100.1 / 99.9, -1, 0, 0, -20 / 99.9, 0], near: 0.1, far: 100 } });
const inBuilding = (p: number) => p % S >= 16 && p % S < 48 && Math.floor(p / S) >= 16 && Math.floor(p / S) < 48;

describe("finishKeyframe", () => {
  it("judges a chain's paint on the candidate's own hole pixels, not on the feathered composite", async () => {
    // B stands 0.3 m right of A, so a 2 px strip on B's right edge is a hole.
    const render = solid([100, 110, 120]), depth = await png(solid([208, 208, 208]));
    const objects = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : inBuilding(i >> 2) ? [100, 120, 140][i % 4]! : 0)));
    const passes: KeyframePasses = { view: { ...view(0.3), objects: [{ object_id: "kettle", rgb: [100, 120, 140] }], floor_id: null, mode: "orbit" },
      render: await png(render), depth, objects };
    const chain: KeyframeChain = { view: view(0), depth, image: await png(solid([200, 160, 40])) };
    const mask = (await png(new Uint8Array(S * S).map((_, p) => (inBuilding(p) ? 255 : 0)), 1)).toString("base64");
    const finish = async (rgb: number[]) => (await finishKeyframe(passes, "kettle", [await png(solid(rgb))], [mask], chain));

    const copy = await finish([100, 110, 120]);
    expect(copy.chain!.hole_share).toBeGreaterThan(0); expect(copy.chain!.hole_share).toBeLessThan(0.05);
    expect(copy.candidates[0]!.painted).toBe(0);
    expect(copy).toMatchObject({ gate: "failed", passed: false });
    // A light repaint: the composite's 2 px feather would dilute it under minPainted (12).
    const painted = await finish([116, 126, 136]);
    expect(painted.candidates[0]!.painted).toBe(16);
    expect(painted).toMatchObject({ gate: "passed", passed: true });
  });
});
