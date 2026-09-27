import { expect, it } from "vitest";
import { measureMotionLandmarks } from "./camera-motion-reference";
const objects = [{ object_id: "inn", rgb: [1, 2, 3] as [number, number, number] }, { object_id: "tower", rgb: [4, 5, 6] as [number, number, number] }];
function pixels(width = 4, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}
it("measures normalized visible pixel centers, area and half-open bounds", () => {
  const data = pixels();
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) data.set([1, 2, 3, 255], (y! * 4 + x!) * 4);
  const result = measureMotionLandmarks(data, 4, 4, objects);
  expect(result.unknown_pixels).toBe(0);
  expect(result.landmarks[0]).toEqual({ object_id: "inn", pixels: 4, fraction: 0.25, centroid: [0.5, 0.5], bounds: [0.25, 0.25, 0.75, 0.75], touches_frame: false });
  expect(result.landmarks[1]).toEqual({ object_id: "tower", pixels: 0, fraction: 0, centroid: null, bounds: null, touches_frame: false });
});
it("marks clipping and unknown colors without assigning them to the closest landmark", () => {
  const data = pixels(); data.set([4, 5, 6, 255], 0); data.set([4, 5, 7, 255], 4); data[11] = 0;
  const result = measureMotionLandmarks(data, 4, 4, objects);
  expect(result.unknown_pixels).toBe(2);
  expect(result.landmarks[1]).toMatchObject({ pixels: 1, centroid: [0.125, 0.125], touches_frame: true });
});
it("rejects malformed dimensions, duplicate identities, black and ambiguous mask colors", () => {
  for (const [width, height] of [[0, 4], [4.5, 4], [4, NaN], [1025, 1], [3, 4]]) expect(() => measureMotionLandmarks(pixels(), width!, height!, objects)).toThrow();
  for (const bad of [[objects[0]!, objects[0]!], [{ object_id: "x", rgb: [0, 0, 0] as [number, number, number] }],
    [objects[0]!, { ...objects[0]!, object_id: "other" }], [{ object_id: "x", rgb: [256, 0, 0] as [number, number, number] }]])
    expect(() => measureMotionLandmarks(pixels(), 4, 4, bad)).toThrow();
});
