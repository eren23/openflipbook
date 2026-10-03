import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { KEYFRAME_GATE } from "./illustration-keyframe";
import { finishKeyframe, keyframeGateBody, type KeyframeChain, type KeyframePasses } from "./illustration-keyframe-server";

const S = 64, f = 1 / Math.tan(25 * Math.PI / 180);
const png = (rgba: Uint8Array, channels: 1 | 4 = 4) => sharp(Buffer.from(rgba), { raw: { width: S, height: S, channels } }).png().toBuffer();
const solid = (rgb: number[]) => new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]!));
// Camera at (x, 0, 0) facing a wall 10 m away that fills the frame (depth byte 208 = 10.03 m).
const view = (x: number) => ({ width: S, height: S, depth: { near: 1, far: 50 },
  camera: { projection: "perspective" as const, world_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
    projection_matrix: [f, 0, 0, 0, 0, f, 0, 0, 0, 0, -100.1 / 99.9, -1, 0, 0, -20 / 99.9, 0], near: 0.1, far: 100 } });
const inBuilding = (p: number) => p % S >= 16 && p % S < 48 && Math.floor(p / S) >= 16 && Math.floor(p / S) < 48;

describe("keyframe gate without a subject", () => {
  it("skips the silhouette: no gate request, and the paint check alone decides", async () => {
    const render = solid([100, 110, 120]);
    const passes: KeyframePasses = { view: { ...view(0), objects: [{ object_id: "well", rgb: [100, 120, 140] }], floor_id: null, mode: "walk" },
      render: await png(render), depth: await png(solid([208, 208, 208])), objects: await png(solid([100, 120, 140])) };
    expect(await keyframeGateBody(passes, null, ["https://fal.media/a.jpg"])).toBeNull();
    expect((await keyframeGateBody(passes, "well", ["https://fal.media/a.jpg"], "well"))?.label).toBe("well");
    const copy = await finishKeyframe(passes, null, [await png(render)], null);
    expect(copy).toMatchObject({ gate: "failed", passed: false, candidates: [{ iou: null, painted: 0, passed: false }] });
    expect(await finishKeyframe(passes, null, [await png(render), await png(solid([180, 190, 200]))], null)).toMatchObject({ gate: "passed", passed: true, chosen: 1 });
  });
});

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

  it("fails a chain candidate that leaves a large object it paints whole in the render's colours", async () => {
    // A saw another surface right of column 44, so B (0.3 m right, 2 px) never saw its columns 42-63:
    // the well there (a quarter of the frame) comes whole from the candidate.
    const render = solid([100, 110, 120]), depth = await png(solid([208, 208, 208]));
    const depthA = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2) % S >= 44 ? 100 : 208)));
    const inWell = (p: number) => p % S >= 48;
    const objects = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : inBuilding(i >> 2) ? [100, 120, 140][i % 4]! : inWell(i >> 2) ? [10, 20, 30][i % 4]! : 0)));
    const passes: KeyframePasses = { view: { ...view(0.3), objects: [{ object_id: "kettle", rgb: [100, 120, 140] }, { object_id: "well", rgb: [10, 20, 30] }], floor_id: null, mode: "walk" },
      render: await png(render), depth, objects };
    const chain: KeyframeChain = { view: view(0), depth: depthA, image: await png(solid([200, 160, 40])) };
    const mask = (await png(new Uint8Array(S * S).map((_, p) => (inBuilding(p) ? 255 : 0)), 1)).toString("base64");
    // Candidate 0 repaints everything but the well (over all its holes it still differs by about 22); candidate 1 repaints all.
    const greyWell = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : render[i]! + (inWell(i >> 2) ? 0 : 80))));
    const done = await finishKeyframe(passes, "kettle", [greyWell, await png(solid([180, 190, 200]))], [mask, mask], chain);
    expect(done.chain!.objects).toEqual({ a: 1, candidate: 1, ground: 0 });
    expect(done.candidates.map(c => [c.painted, c.passed])).toEqual([[0, false], [80, true]]);
    expect(done).toMatchObject({ chosen: 1, gate: "passed" });
  });

  it("judges on its own only an object the candidate paints whole, not an A-sourced one or a flat path", async () => {
    // A saw another surface right of column 40, so B (0.3 m right) never saw its columns 38-63.
    const depth = await png(solid([208, 208, 208])), depthA = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2) % S >= 40 ? 100 : 208)));
    const finish = async (camera: (x: number) => ReturnType<typeof view>, inObject: (p: number) => boolean, render: Uint8Array, mask: string | null) => {
      const objects = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : inObject(i >> 2) ? [100, 120, 140][i % 4]! : 0)));
      const passes: KeyframePasses = { view: { ...camera(0.3), objects: [{ object_id: "kettle", rgb: [100, 120, 140] }], floor_id: null, mode: "walk" }, render: await png(render), depth, objects };
      const chain: KeyframeChain = { view: camera(0), depth: depthA, image: await png(solid([200, 160, 40])) };
      // The candidate leaves the object in the render's colours and repaints everything else by 80.
      const candidate = await png(new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : render[i]! + (inObject(i >> 2) ? 0 : 80))));
      return finishKeyframe(passes, mask ? "kettle" : null, [candidate], mask ? [mask] : null, chain);
    };
    // The inn: A saw 69% of it, so it comes from A, but its unseen columns (8% of the frame) are holes the candidate leaves grey.
    const inn = await finish(view, inBuilding, solid([100, 110, 120]), (await png(new Uint8Array(S * S).map((_, p) => (inBuilding(p) ? 255 : 0)), 1)).toString("base64"));
    expect(inn.chain!.objects).toEqual({ a: 1, candidate: 0, ground: 0 });
    expect(inn).toMatchObject({ gate: "passed", passed: true });
    // Looking straight down at a tan path (the top three quarters of the frame): it is flat, so ground, and painted tan.
    const down = (x: number) => ({ ...view(x), camera: { ...view(x).camera, world_matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, x, 10, 0, 1] } });
    const onPath = (p: number) => p < S * 48;
    const path = await finish(down, onPath, new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : onPath(i >> 2) ? [180, 150, 100][i % 4]! : [100, 110, 120][i % 4]!)), null);
    expect(path.chain!.objects).toEqual({ a: 0, candidate: 0, ground: 1 });
    expect(path.candidates[0]!.painted).toBeGreaterThan(KEYFRAME_GATE.minPainted);
  });
});
