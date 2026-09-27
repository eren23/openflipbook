import { expect, it } from "vitest";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { mapObject } from "./map-artwork";
import { correctMapLandmarks } from "./map-alignment-correction";
import type { MapAlignmentDraft } from "./map-alignment";
import { resolveSceneObject } from "./floor-placement";

function fixture() {
  const building = { ...newComponent("building", 10, 12), id: "inn", label: "Inn", heading: Math.PI / 2 };
  const contents = { ...newComponent("bench", 0, 0), id: "seat", width: 1, depth: 0.5, placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } };
  const definition = { ...emptyPlaceScene(), objects: [building, contents, { ...newComponent("house", 30, 10), id: "shop", label: "Shop" }] };
  const frame = { width: 1600, height: 900 }, registration = { x: 50, y: 50, width: 60, rotation: 27 };
  const point = mapObject({ ...building, x: 14, z: 18 }, definition, registration, frame);
  const draft: MapAlignmentDraft = { _id: "world:place", session_id: "world", place_id: "place", scene_id: "scene", scene_source_node_id: "image", scene_revision: 1, map_node_id: "image", revision: 1, updated_at: new Date(0), frame, registration, landmarks: [{ object_id: "inn", x: point.cx / frame.width * 100, y: point.cy / frame.height * 100 }] };
  return { definition, draft };
}
it("inverts the saved pixel projection while preserving identities, architecture, materials and local contents", () => {
  const { definition, draft } = fixture(), before = structuredClone(definition);
  const next = correctMapLandmarks(definition, draft, ["inn"]);
  expect(definition).toEqual(before);
  expect(next.objects[0]!.x).toBeCloseTo(14); expect(next.objects[0]!.z).toBeCloseTo(18);
  expect({ ...next.objects[0], x: 10, z: 12 }).toEqual(definition.objects[0]);
  expect(next.objects.slice(1)).toEqual(definition.objects.slice(1));
  const oldSeat = resolveSceneObject(definition, definition.objects[1]!), newSeat = resolveSceneObject(next, next.objects[1]!);
  expect(newSeat.x - oldSeat.x).toBeCloseTo(4); expect(newSeat.z - oldSeat.z).toBeCloseTo(6);
});
it("rejects missing, duplicate and unmarked targets", () => {
  const { definition, draft } = fixture();
  for (const ids of [[], ["inn", "inn"], ["shop"], ["seat"], ["foreign"]]) expect(() => correctMapLandmarks(definition, draft, ids)).toThrow("Select saved landmarks");
});
it("refuses collisions and out-of-bounds corrections instead of clamping the geometry", () => {
  const { definition, draft } = fixture();
  const collision = mapObject(definition.objects[2]!, definition, draft.registration, draft.frame);
  draft.landmarks[0] = { object_id: "inn", x: collision.cx / draft.frame.width * 100, y: collision.cy / draft.frame.height * 100 };
  expect(() => correctMapLandmarks(definition, draft, ["inn"])).toThrow(/overlaps|crowds/);
  draft.landmarks[0] = { object_id: "inn", x: 0, y: 0 };
  expect(() => correctMapLandmarks(definition, draft, ["inn"])).toThrow();
});
