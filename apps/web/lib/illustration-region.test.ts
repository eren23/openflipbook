import { expect, it } from "vitest";
import sharp from "sharp";
import { composeRegisteredObjects, registeredPixels, selectedObjectIds } from "./illustration-region";

const view = { width: 32, height: 32, objects: [{ object_id: "roof", rgb: [1, 2, 3] as [number, number, number] }, { object_id: "wall", rgb: [4, 5, 6] as [number, number, number] }] };
const png = (data: Buffer) => sharp(data, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
async function fixture() {
  const base = Buffer.alloc(4096), proposal = Buffer.alloc(4096), mask = Buffer.alloc(4096);
  for (let i = 0; i < 1024; i++) {
    base.set([i % 256, 80, 90, i % 2 ? 255 : 100], i * 4); proposal.set([200, 150, 60, 255], i * 4);
    mask.set(i < 300 ? [1, 2, 3, 255] : i < 600 ? [4, 5, 6, 255] : [0, 0, 0, 255], i * 4);
  }
  return { base, proposal, mask, basePng: await png(base), proposalPng: await png(proposal), maskPng: await png(mask) };
}
it("preserves every outside RGBA pixel including alpha, background and other objects", async () => {
  const f = await fixture(), out = await composeRegisteredObjects(f.basePng, f.proposalPng, f.maskPng, view, ["roof"]);
  expect(out).toMatchObject({ selected_pixels: 300, protected_pixels: 724 });
  const decoded = await registeredPixels(out.bytes, 32, 32, true);
  expect(decoded.subarray(0, 1200)).toEqual(f.proposal.subarray(0, 1200));
  expect(decoded.subarray(1200)).toEqual(f.base.subarray(1200));
});
it("uses the decoded JPEG as the base without lossy re-encoding of protected pixels", async () => {
  const f = await fixture(), jpeg = await sharp(f.basePng).jpeg({ quality: 80 }).toBuffer();
  const out = await composeRegisteredObjects(jpeg, f.proposalPng, f.maskPng, view, ["wall"]);
  const before = await registeredPixels(jpeg, 32, 32), after = await registeredPixels(out.bytes, 32, 32);
  expect(after.subarray(0, 1200)).toEqual(before.subarray(0, 1200)); expect(after.subarray(2400)).toEqual(before.subarray(2400));
});
it("clips painted and erased subregions to stable objects, preserving all other RGBA pixels", async () => {
  const f = await fixture();
  const out = await composeRegisteredObjects(f.basePng, f.proposalPng, f.maskPng, view, ["roof"], [
    { operation: "paint", radius: 2, points: [[10, 4]] },
    { operation: "erase", radius: 1, points: [[10, 4]] },
    { operation: "paint", radius: 2, points: [[10, 14]] },
  ]);
  expect(out).toMatchObject({ selected_pixels: 8, protected_pixels: 1016 });
  const pixels = await registeredPixels(out.bytes, 32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const distance = (x - 10) ** 2 + (y - 4) ** 2, offset = (y * 32 + x) * 4;
    const expected = distance > 1 && distance <= 4 ? f.proposal : f.base;
    expect(pixels.subarray(offset, offset + 4)).toEqual(expected.subarray(offset, offset + 4));
  }
  for (const strokes of [[], [{ operation: "paint" as const, radius: 2, points: [[10, 14] as [number, number]] }]]) await expect(composeRegisteredObjects(f.basePng, f.proposalPng, f.maskPng, view, ["roof"], strokes)).rejects.toThrow("no visible pixels");
});
it.each([2, 3, 4, 5, 6, 7, 8])("rejects EXIF orientation %s even when the encoded dimensions match", async orientation => {
  const f = await fixture(), jpeg = await sharp(f.basePng).withMetadata({ orientation }).jpeg().toBuffer();
  expect((await sharp(jpeg).metadata()).orientation).toBe(orientation);
  await expect(registeredPixels(jpeg, 32, 32)).rejects.toMatchObject({ status: 400 });
});
it("accepts explicit normal orientation without rotating the registered pixels", async () => {
  const f = await fixture(), jpeg = await sharp(f.basePng).withMetadata({ orientation: 1 }).jpeg().toBuffer();
  expect(await registeredPixels(jpeg, 32, 32)).toEqual(await sharp(jpeg).toColourspace("srgb").ensureAlpha().raw().toBuffer());
});
it("rejects invisible selections and never expands approximate or transparent mask colors", async () => {
  const f = await fixture(); f.mask[3] = 254; f.mask[4] = 2;
  const out = await composeRegisteredObjects(f.basePng, f.proposalPng, await png(f.mask), view, ["roof"]);
  expect(out.selected_pixels).toBe(298);
  const decoded = await registeredPixels(out.bytes, 32, 32); expect(decoded.subarray(0, 8)).toEqual(f.base.subarray(0, 8));
  await expect(composeRegisteredObjects(f.basePng, f.proposalPng, f.maskPng, { ...view, objects: [...view.objects, { object_id: "hidden", rgb: [9, 9, 9] }] }, ["hidden"])).rejects.toMatchObject({ status: 409 });
});
it("rejects malformed selections and returns canonical ordering", () => {
  for (const input of [null, [], ["missing"], ["roof", "roof"], [123], Array(129).fill("roof")]) expect(() => selectedObjectIds(input, view.objects)).toThrow();
  expect(selectedObjectIds(["wall", "roof"], view.objects)).toEqual(["roof", "wall"]);
});
it("fails closed for corrupt, wrong-size or non-PNG masks and all-image selections", async () => {
  const f = await fixture(), wrong = await sharp(f.basePng).resize(33, 32).png().toBuffer();
  await expect(registeredPixels(wrong, 32, 32)).rejects.toThrow();
  await expect(registeredPixels(Buffer.from("broken"), 32, 32)).rejects.toThrow();
  await expect(registeredPixels(f.basePng, Infinity, 32)).rejects.toThrow();
  await expect(registeredPixels(await sharp(f.basePng).jpeg().toBuffer(), 32, 32, true)).rejects.toThrow();
  const mask = Buffer.alloc(4096); for (let i = 0; i < 4096; i += 4) mask.set([1, 2, 3, 255], i);
  await expect(composeRegisteredObjects(f.basePng, f.proposalPng, await png(mask), view, ["roof"])).rejects.toMatchObject({ status: 400 });
});
