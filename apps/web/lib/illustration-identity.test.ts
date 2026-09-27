import { expect, it } from "vitest";
import { illustrationIdentity, usesIllustrationIdentity } from "./illustration-identity";
import { newComponent } from "./place-scene";
import type { ViewSource } from "./place-view";

const kettle = { ...newComponent("building", 10, 20), id: "kettle", label: "Copper Kettle" };
const hidden = { ...newComponent("building", 30, 20), id: "hidden", label: "Hidden hall" };
const sources: ViewSource[] = [{ scene_id: "scene", place_id: "place", revision: 4, x: 0, z: 0,
  definition: { version: 1, width: 80, depth: 80, units: "authored_metres", entrance: { x: 40, z: 78, yaw: 0 }, label: "District", objects: [kettle, hidden] } }];
const view = { width: 32, height: 32, mode: "orbit" as const, floor_id: null,
  objects: [{ object_id: kettle.id, rgb: [1, 2, 3] as [number, number, number] }, { object_id: hidden.id, rgb: [4, 5, 6] as [number, number, number] }] };
function mask() {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 8; y < 16; y++) for (let x = 0; x < 8; x++) pixels.set([1, 2, 3, 255], (y * 32 + x) * 4);
  pixels.set([4, 5, 6, 0], 0);
  return pixels;
}
it("describes only opaque visible identities at actual screen positions", () => {
  const before = structuredClone(sources);
  const result = illustrationIdentity(view, sources, mask());
  expect(result.objects).toHaveLength(1);
  expect(result.objects[0]).toMatchObject({ id: "kettle", label: "Copper Kettle", place_id: "place", scene_revision: 4,
    visible_pixels: 64, center_percent: [12.5, 37.5], bounds_percent: [0, 25, 25, 50], dimensions_m: [kettle.width, kettle.height, kettle.depth] });
  expect(JSON.stringify(result)).not.toContain("Hidden hall");
  expect(sources).toEqual(before);
});
it("does not invent identities for unknown mask colours or sub-four-pixel specks", () => {
  const pixels = new Uint8Array(32 * 32 * 4).fill(255);
  pixels.set([1, 2, 3, 255], 0);
  expect(illustrationIdentity(view, sources, pixels).objects).toEqual([]);
});
it("bounds context size deterministically and exposes omitted identities", () => {
  const objects = Array.from({ length: 30 }, (_, i) => ({ ...kettle, id: `b${String(i).padStart(2, "0")}` }));
  const capture = { ...view, objects: objects.map((o, i) => ({ object_id: o.id, rgb: [i + 1, 0, 0] as [number, number, number] })) };
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 30; i++) for (let p = 0; p < 4; p++) pixels.set([i + 1, 0, 0, 255], (i * 4 + p) * 4);
  const result = illustrationIdentity(capture, [{ ...sources[0]!, definition: { ...sources[0]!.definition, objects } }], pixels);
  expect(result.objects).toHaveLength(24); expect(result.omitted_visible_objects).toBe(6);
  expect(result.objects[0]?.id).toBe("b00"); expect(result.objects[23]?.id).toBe("b23");
});
it("rejects mismatched pixels or visible identities absent from geometry", () => {
  expect(() => illustrationIdentity(view, sources, new Uint8Array(4))).toThrow("dimensions");
  expect(() => illustrationIdentity(view, [], mask())).toThrow("missing");
});
it("adds identity inputs only to the versioned full and masked contracts", () => {
  for (const prompt_version of ["saved-camera-depth-identity-v2", "registered-object-inpaint-depth-identity-v2"]) expect(usesIllustrationIdentity({ prompt_version })).toBe(true);
  expect(usesIllustrationIdentity({ prompt_version: "saved-camera-depth-v1" })).toBe(false);
  expect(usesIllustrationIdentity()).toBe(false);
});
