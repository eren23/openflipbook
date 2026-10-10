import { expect, it } from "vitest";
import { emptyPlaceScene, newComponent, parsePlaceScene } from "./place-scene";
import { applySceneTextEdits } from "./scene-text-edit";
const scene = () => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...newComponent("building", 12, 12), id: "inn", entity_id: "inn-entity" }, { ...newComponent("tree", 30, 12), id: "oak", entity_id: "oak-entity" }] });
const edit = (edits: unknown[]) => ({ version: 1, edits });
it("preserves saved architectural, object and entity identities across roof, door and movement edits", () => {
  const base = scene(), old = base.objects[0]!;
  const result = applySceneTextEdits(base, edit([{ op: "move", target: "inn", dx: 2, dz: 0 }, { op: "roof", target: "inn", roof_height: 1.2 }, { op: "door", target: "inn", changes: { offset: 1 } }]), "job", ["inn"]);
  const next = result.definition.objects[0]!;
  expect(next).toMatchObject({ id: old.id, entity_id: old.entity_id, x: 14 });
  expect(next.structure).toMatchObject({ floors: old.structure!.floors, door: { id: old.structure!.door.id, offset: 1 }, windows: old.structure!.windows, roof_height: 1.2 });
  expect(result.definition.objects[1]).toEqual(base.objects[1]); expect(result.object_ids).toEqual(["inn"]); expect(base.objects[0]!.x).toBe(12);
});
it("allows a selected building's furnishings while rotating world movement into floor-local metres", () => {
  const base = scene(), building = base.objects[0]!; building.heading = Math.PI / 2;
  const bench = { ...newComponent("bench", -1, 0), id: "seat", entity_id: "seat-entity", placement: { building_id: "inn", floor_id: building.structure!.floors[0]!.id } };
  base.objects.push(bench);
  const next = applySceneTextEdits(parsePlaceScene(base), edit([{ op: "move", target: "seat", dx: 1, dz: 0 }]), "job", ["inn"]).definition;
  expect(next.objects[2]!.x).toBeCloseTo(-1); expect(next.objects[2]!.z).toBeCloseTo(-1); expect(next.objects[2]!.placement).toEqual(bench.placement);
});
it("deterministically adds scoped furnishings using the saved building and floor IDs", () => {
  const base = scene(), addition = { ...newComponent("bench", -1, -1), id: "new-seat", entity_id: "new-seat-entity", placement: { building_id: "inn", floor_id: base.objects[0]!.structure!.floors[0]!.id } };
  const run = () => applySceneTextEdits(base, edit([{ op: "add", object: addition }]), "same-job", ["inn"]);
  expect(run()).toEqual(run()); expect(run().definition.objects[2]!.placement).toEqual(addition.placement);
  expect(run().definition.objects[2]!.id).toMatch(/^gen_edit_/); expect(run().object_ids).toEqual([run().definition.objects[2]!.id]);
});
it.each([
  edit([{ op: "patch", target: "inn", changes: { id: "replacement" } }]),
  edit([{ op: "patch", target: "oak", changes: { color: "#123456" } }]),
  edit([{ op: "door", target: "inn", changes: { id: "other-door" } }]),
  edit([{ op: "door", target: "inn", changes: { width: 100 } }]),
  edit([{ op: "move", target: "inn", dx: 100, dz: 0 }]),
  edit([{ op: "patch", target: "inn", changes: { color: "red" } }]),
  edit([{ op: "add", object: newComponent("building", 28, 28) }]),
  { version: 1, edits: [], definition: {} },
])("rejects replacement identities, scope changes and invalid canonical geometry", raw => {
  expect(() => applySceneTextEdits(scene(), raw, "job", ["inn"])).toThrow();
});
it("checks edited exterior collision even when the same response also contains additions", () => {
  const base = scene(); const bench = { ...newComponent("bench", 5, 5), id: "bench", entity_id: "bench-entity" };
  expect(() => applySceneTextEdits(base, edit([{ op: "move", target: "inn", dx: 18, dz: 0 }, { op: "add", object: bench }]), "job", [])).toThrow(/overlaps|crowds/);
});
it("requires explicitly removing bound furnishings before their building", () => {
  const base = scene(); base.objects.push({ ...newComponent("bench", -1, -1), id: "seat", entity_id: "seat-entity", placement: { building_id: "inn", floor_id: base.objects[0]!.structure!.floors[0]!.id } });
  expect(() => applySceneTextEdits(base, edit([{ op: "remove", target: "inn" }]), "job", [])).toThrow();
  expect(applySceneTextEdits(base, edit([{ op: "remove", target: "seat" }, { op: "remove", target: "inn" }]), "job", []).object_ids).toEqual(["inn", "seat"]);
});
it("rejects a no-op rather than inventing a world change", () => {
  expect(() => applySceneTextEdits(scene(), edit([{ op: "move", target: "inn", dx: 0, dz: 0 }]), "job", [])).toThrow("No world changes");
});
