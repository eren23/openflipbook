// @vitest-environment node
import { createHash } from "node:crypto";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import sharp from "sharp";
import { expect, it } from "vitest";
import { LOCAL_VISUAL_SEGMENTATION_PROFILE, localVisualGeometry } from "./illustration-local-visual";
import type { ViewCapture } from "./place-view";

async function visualFixture() {
  const colors: [number, number, number][] = [[51, 68, 85], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
  const ids = ["building", "inn", "forge", "glass", "road"], rectangles = [[0, 0, 160, 280], [180, 10, 220, 60], [500, 0, 680, 290], [380, 50, 460, 100]];
  const pixels = Buffer.alloc(688 * 384 * 3);
  for (let y = 0; y < 384; y++) for (let x = 0; x < 688; x++) {
    const index = rectangles.findIndex(([x0, y0, x1, y1]) => x >= x0! && x < x1! && y >= y0! && y < y1!);
    const rgb = colors[index < 0 ? 4 : index]!;
    pixels.set(rgb, (y * 688 + x) * 3);
  }
  const objects = await sharp(pixels, { raw: { width: 688, height: 384, channels: 3 } }).png().toBuffer();
  const view = { width: 688, height: 384, objects: ids.map((object_id, i) => ({ object_id, rgb: colors[i]! })) } as ViewCapture;
  const definition = { objects: ids.map((id, i) => ({ id, label: i < 4 ? ["A", "B", "C", "D"][i]! : "Road", kind: i < 4 ? "building" : "path" })) } as PlaceSceneDefinition;
  const jpeg = await sharp({ create: { width: 688, height: 384, channels: 3, background: "#bd6c3c" } }).jpeg().toBuffer();
  const mask = Buffer.alloc(688 * 384); for (let y = 0; y < 280; y++) mask.fill(255, y * 688, y * 688 + 160);
  return { view, definition, objects, jpeg, mask: await sharp(mask, { raw: { width: 688, height: 384, channels: 1 } }).png().toBuffer() };
}
const labels = ["A", "B", "C", "D"], box = [0, 0, 160, 280];
it("derives the exact registered box and deterministic eroded positive/negative points from four source IDs", async () => {
  const f = await visualFixture(), result = await localVisualGeometry(f.view, f.definition, labels, "building", f.objects, f.jpeg, box);
  expect(result.geometry.objects_data_url).toBe(`data:image/png;base64,${f.objects.toString("base64")}`);
  expect(result.proof).toEqual({ version: LOCAL_VISUAL_SEGMENTATION_PROFILE, width: 688, height: 384, point_margin: 8,
    objects_sha256: createHash("sha256").update(f.objects).digest("hex"), image_sha256: createHash("sha256").update(f.jpeg).digest("hex"),
    subject_rgb: [51, 68, 85], other_building_rgbs: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], road_rgb: [10, 11, 12],
    box_prompts: [{ x_min: 0, y_min: 0, x_max: 160, y_max: 280, object_id: 1 }],
    point_prompts: [[79, 73, 1], [79, 205, 1], [199, 34, 0], [589, 144, 0], [419, 74, 0], [343, 341, 0]].map(([x, y, label]) => ({ x, y, label, object_id: 1 })) });
});
it("rejects missing/ambiguous source identities, nonlandmark subjects and guessed road colors", async () => {
  const f = await visualFixture();
  await expect(localVisualGeometry(f.view, f.definition, ["A", "B", "C", "A"], "building", f.objects, f.jpeg, box)).rejects.toMatchObject({ status: 409 });
  await expect(localVisualGeometry(f.view, f.definition, labels, "road", f.objects, f.jpeg, box)).rejects.toMatchObject({ status: 409 });
  f.definition.objects[4]!.kind = "pond";
  await expect(localVisualGeometry(f.view, f.definition, labels, "building", f.objects, f.jpeg, box)).rejects.toMatchObject({ status: 409 });
});
it("rejects duplicated saved RGBs, moved subject boxes and translucent source masks", async () => {
  const f = await visualFixture();
  await expect(localVisualGeometry(f.view, f.definition, labels, "building", f.objects, f.jpeg, [0, 0, 159, 280])).rejects.toMatchObject({ status: 409 });
  f.view.objects[1]!.rgb = f.view.objects[0]!.rgb;
  await expect(localVisualGeometry(f.view, f.definition, labels, "building", f.objects, f.jpeg, box)).rejects.toMatchObject({ status: 409 });
  f.view.objects[1]!.rgb = [1, 2, 3];
  const translucent = await sharp(f.objects).ensureAlpha(.5).png().toBuffer();
  await expect(localVisualGeometry(f.view, f.definition, labels, "building", translucent, f.jpeg, box)).rejects.toMatchObject({ status: 409 });
});
