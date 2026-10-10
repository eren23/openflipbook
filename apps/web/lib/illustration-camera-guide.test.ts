import sharp from "sharp";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { prepareKeyframeCameraGuides } from "./illustration-camera-guide";
import type { KeyframePasses } from "./illustration-keyframe";
import type { ViewSource } from "./place-view";
const width = 688, height = 384, labels = ["Bookshop", "Inn", "Forge", "Conservatory"], colors: [number, number, number][] = [[10,20,30],[40,50,60],[70,80,90],[100,110,120]];
const landmarks = labels.map((label, i) => ({ label, left: i * 40, top: 0, width: 32, height: 32 }));
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture() {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 60; y < 160; y++) for (let x = 0; x < width; x++) { const i = Math.floor(x / 172); pixels.set([...colors[i]!,255], (y * width + x) * 4); }
  const objects = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const render = await sharp({ create: { width, height, channels: 3, background: "#34565a" } }).png().toBuffer();
  const depth = await sharp({ create: { width, height, channels: 3, background: "#aaaaaa" } }).png().toBuffer();
  const passes = { view: { width, height, objects: colors.map((rgb, i) => ({ rgb, object_id: `obj${i}` })) }, render, depth, objects } as KeyframePasses;
  const sources = [{ definition: { objects: labels.map((label, i) => ({ id: `obj${i}`, label, kind: "building" })) } }] as ViewSource[];
  return { passes, sources };
}
describe("saved camera structural guides", () => {
  it("pins original three passes, numbers actual opaque identities, and leaves depth bytes unchanged", async () => {
    const { passes, sources } = await fixture(), original = Buffer.from(passes.render);
    const guide = await prepareKeyframeCameraGuides(passes, sources, landmarks), png = Buffer.from(guide.structural_guide_url.split(",")[1]!, "base64");
    expect(guide.proof).toMatchObject({ guide_sha256: hash(png), render_sha256: hash(passes.render), objects_sha256: hash(passes.objects), depth_sha256: hash(passes.depth) });
    expect(guide.proof.landmarks.map(l => [l.index, l.label, l.object_id, l.visible_pixels])).toEqual(labels.map((label, i) => [i + 1, label, `obj${i}`, 17200]));
    expect(Buffer.from(guide.depth_guide_url.split(",")[1]!, "base64")).toEqual(passes.depth);
    expect(passes.render).toEqual(original);expect(await sharp(png).metadata()).toMatchObject({ format: "png", width, height });
    const result = await sharp(png).ensureAlpha().raw().toBuffer();
    expect(Array.from(result.subarray((60 * width + 20) * 4, (60 * width + 20) * 4 + 4))).toEqual([255,235,20,255]);
    expect(Array.from(result.subarray((300 * width + 20) * 4, (300 * width + 20) * 4 + 4))).toEqual([52,86,90,255]);
  });
  it("provides binary label-free control edges from the saved pixels while preserving legacy guide bytes", async () => {
    const { passes, sources } = await fixture();
    const legacy = await prepareKeyframeCameraGuides(passes, sources, landmarks);
    const controlled = await prepareKeyframeCameraGuides(passes, sources, landmarks, "saved-camera-controlnet-v1");
    expect(controlled.structural_guide_url).toBe(legacy.structural_guide_url);
    expect(legacy.proof).not.toHaveProperty("outline_sha256");expect(legacy).not.toHaveProperty("outline_guide_url");
    const png = Buffer.from(controlled.outline_guide_url!.split(",")[1]!, "base64"), pixels = await sharp(png).removeAlpha().raw().toBuffer();
    expect(controlled.proof).toMatchObject({ version: "saved-camera-controlnet-v1", outline_sha256: hash(png), render_sha256: hash(passes.render), objects_sha256: hash(passes.objects), depth_sha256: hash(passes.depth) });
    expect(new Set(pixels)).toEqual(new Set([0,255]));
    expect(Array.from(pixels.subarray((60 * width + 20) * 3, (60 * width + 20) * 3 + 3))).toEqual([255,255,255]);
    // Badge1's centre is plain black in the control edge input.
    expect(Array.from(pixels.subarray((110 * width + 86) * 3, (110 * width + 86) * 3 + 3))).toEqual([0,0,0]);
    expect(controlled.depth_guide_url).toBe(legacy.depth_guide_url);
  });
  it("refuses an absent, duplicated, or invisible named landmark instead of inventing a screen location", async () => {
    const { passes, sources } = await fixture();
    await expect(prepareKeyframeCameraGuides(passes, sources, [...landmarks.slice(0, 3), { ...landmarks[3]!, label: "Absent" }])).rejects.toThrow(/missing/);
    await expect(prepareKeyframeCameraGuides(passes, sources, [landmarks[0]!, landmarks[0]!, landmarks[2]!, landmarks[3]!])).rejects.toThrow(/distinct/);
    passes.view.objects[3]!.rgb = [200,200,200];
    await expect(prepareKeyframeCameraGuides(passes, sources, landmarks)).rejects.toThrow(/visible/);
  });
  it("refuses misregistered input passes or the old camera aspect", async () => {
    const { passes, sources } = await fixture();passes.depth = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer();
    await expect(prepareKeyframeCameraGuides(passes, sources, landmarks)).rejects.toThrow();passes.view.width = 1024;
    await expect(prepareKeyframeCameraGuides(passes, sources, landmarks)).rejects.toThrow(/registered/);
  });
});
