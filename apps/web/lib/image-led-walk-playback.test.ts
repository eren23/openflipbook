// @vitest-environment node
import { expect, it } from "vitest";
import sharp from "sharp";
import { imageLedPlayback, prepareImageLedPlayback, validateImageLedPlayback } from "./image-led-walk-playback";
import type { ImageLedPlayback, ImageLedWalkDoc } from "./image-led-walk";

const canvas: ImageLedPlayback = { kind: "contain-jpeg-v1", width: 688, height: 384, background: "#20231e" };
it.each([[1536, 864], [1376, 768], [256, 256]])("preserves the entire %ix%i image on the shared endpoint canvas", async (width, height) => {
  const original = await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="red" stroke-width="16"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 5}" fill="black"/></svg>`)).png().toBuffer();
  const before = Buffer.from(original), output = await prepareImageLedPlayback(original, canvas);
  const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 688, height: 384 }); expect(original).toEqual(before);
  const dark = (x: number, y: number) => { const p = (y * info.width + x) * info.channels; return data[p]! < 15 && data[p + 1]! < 15 && data[p + 2]! < 15; };
  const horizontal = Array.from({ length: info.width }, (_, x) => dark(x, 192)).filter(Boolean).length;
  const vertical = Array.from({ length: info.height }, (_, y) => dark(344, y)).filter(Boolean).length;
  expect(Math.abs(horizontal - vertical)).toBeLessThanOrEqual(2);
  const red = (x: number, y: number) => { const p = (y * info.width + x) * info.channels; return data[p]! > 160 && data[p + 1]! < 80 && data[p + 2]! < 80; };
  expect(Array.from({ length: info.width }, (_, x) => red(x, 192)).filter(Boolean).length).toBeGreaterThan(2);
  expect(Array.from({ length: info.height }, (_, y) => red(344, y)).filter(Boolean).length).toBeGreaterThan(2);
});
it("uses the reviewed first frame, then seed, then the fixed 16:9 default", () => {
  const walk = { frames: [], seed: { image: { width: 688, height: 384 } } } as unknown as ImageLedWalkDoc;
  expect(imageLedPlayback(walk)).toEqual(canvas);
  walk.frames = [{ image: { width: 640, height: 360 } }] as ImageLedWalkDoc["frames"];
  expect(imageLedPlayback(walk)).toMatchObject({ width: 640, height: 360 });
  expect(imageLedPlayback({ frames: [] } as unknown as ImageLedWalkDoc)).toMatchObject({ width: 688, height: 387 });
});
it.each([{ width: 0 }, { height: 4097 }, { background: "white" }, { crop: true }, { kind: "stretch" }])("rejects changed or unsupported canvas instructions %j", change => {
  expect(() => validateImageLedPlayback({ ...canvas, ...change } as ImageLedPlayback)).toThrow("Quoted playback canvas changed");
});
