import { test } from "node:test";
import assert from "node:assert/strict";
import { assertUnchangedObjects, buildConnectionInput, hashDefinition, proposalApproved, requireAppearanceReview, runContinuationPhase, validateAppearanceEdit, validateFurnishing, validateStructuralEdit } from "./quality-pilot-continuation.mjs";

const definition = () => ({ version: 2, label: "Saved district", width: 40, depth: 40, units: "authored_metres", entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [
  { id: "workshop", entity_id: "workshop-entity", kind: "building", label: "Copper Workshop", x: 20, z: 20, width: 9, depth: 10, height: 7.8, structure: { floors: [{ id: "ground" }, { id: "upper" }], stair: { id: "stairs" } }, materials: { wall: { asset_id: "limestone", tile_metres: 3, rotation: 0, roughness: 0.9 }, roof: { asset_id: "teal", tile_metres: 2, rotation: 0, roughness: 0.6 } } },
  { id: "bakery", entity_id: "bakery-entity", kind: "building", label: "Bakery", x: 5, z: 10 },
  { id: "chair", entity_id: "chair-entity", kind: "mesh", label: "Upper chair", asset_id: "generated-chair", x: 1, z: 2, placement: { building_id: "workshop", floor_id: "upper" } },
] });
test("requires the reviewed actual appearance and applied capture, not just an earlier layout", () => {
  const hash = hashDefinition(definition()), manifest = { phases: { capture: { status: "complete" }, appearance: { result: { definition_sha256: hash } } }, reviews: { appearance: { approved: true, definition_sha256: hash, reviewed_at: new Date().toISOString() } } };
  requireAppearanceReview(manifest);
  for (const bad of [ { ...manifest, reviews: {} }, { ...manifest, reviews: { appearance: { ...manifest.reviews.appearance, definition_sha256: "stale" } } }, { ...manifest, phases: { ...manifest.phases, capture: { status: "reserved" } } } ]) assert.throws(() => requireAppearanceReview(bad));
});
test("unreviewed continuation refuses before reading or sending any paid request", async () => {
  let calls = 0;
  await assert.rejects(runContinuationPhase({ phase: "edit", manifest: { phases: {} }, get: () => calls++, post: () => calls++ }));
  assert.equal(calls, 0);
});
test("exact preview approval cannot approve another proposal or changed geometry", () => {
  const proposal = { id: "saved-proposal", definition: definition() }, review = { approved: true, proposal_id: proposal.id, definition_sha256: hashDefinition(proposal.definition), reviewed_at: new Date().toISOString() };
  const manifest = { reviews: { furnishing: { "upper-floor": review } } };
  assert.equal(proposalApproved(manifest, "furnishing", "upper-floor", proposal), true);
  assert.equal(proposalApproved(manifest, "furnishing", "upper-floor", { ...proposal, id: "new-id" }), false);
  const changed = structuredClone(proposal); changed.definition.objects[0].x++; assert.equal(proposalApproved(manifest, "furnishing", "upper-floor", changed), false);
});
test("furnishing preserves all prior named objects and scopes both additions to the saved upper floor", () => {
  const before = definition(), after = structuredClone(before), target = { building_id: "workshop", floor_id: "upper" };
  after.objects.push({ id: "bench", entity_id: "bench-entity", label: "Reading bench", kind: "bench", placement: target }, { id: "barrels", entity_id: "barrels-entity", label: "Workshop storage barrels", kind: "barrels", placement: target });
  validateFurnishing(before, after, target);
  const changed = structuredClone(after); changed.objects.at(-1).placement.floor_id = "ground"; assert.throws(() => validateFurnishing(before, changed, target), /upper floor/);
  const overwritten = structuredClone(after); overwritten.objects[1].x++; assert.throws(() => validateFurnishing(before, overwritten, target), /Unselected/);
  const mislabeled = structuredClone(after); mislabeled.objects.at(-1).kind = "bench"; assert.throws(() => validateFurnishing(before, mislabeled, target), /requested component/);
});
test("structural edit moves the target exactly one metre without changing its local prop or neighbors", () => {
  const before = definition(), after = structuredClone(before); after.objects[0].x++;
  validateStructuralEdit(before, after, "workshop");
  const drift = structuredClone(after); drift.objects[2].x++; assert.throws(() => validateStructuralEdit(before, drift, "workshop"), /Unselected/);
  const door = structuredClone(after); door.objects[0].structure.stair.id = "replacement"; assert.throws(() => validateStructuralEdit(before, door, "workshop"), /beyond/);
});
test("appearance edit reuses exact owned texture bytes and changes only wall tile scale", () => {
  const before = definition(), after = structuredClone(before); after.objects[0].materials.wall.tile_metres = 1.5;
  validateAppearanceEdit(before, after, "workshop", 1.5);
  const replacement = structuredClone(after); replacement.objects[0].materials.wall.asset_id = "new-texture"; assert.throws(() => validateAppearanceEdit(before, replacement, "workshop", 1.5), /reuse/);
  const resized = structuredClone(after); resized.objects[0].width++; assert.throws(() => validateAppearanceEdit(before, resized, "workshop", 1.5), /geometry/);
});
test("context preserves the sorted exact relevant boundary identities without neighboring scene bytes", () => {
  const link = (id, a, b) => ({ id, version: 1, kind: "boundary", a: { place_id: a, side: "east", offset: 20 }, b: { place_id: b, side: "west", offset: 16 }, width: 3, created_at: "2026-10-04", extra: "private" });
  const input = buildConnectionInput("district", { connections: [link("z", "district", "annex"), link("unrelated", "other", "third"), link("a", "neighbor", "district")], chunks: [{ private_bytes: true }] });
  assert.deepEqual(input.connections.map(item => item.id), ["a", "z"]); assert.equal(input.place_id, "district"); assert.equal(input.version, 1);
  assert.doesNotMatch(JSON.stringify(input), /private|unrelated|chunks/);
});
test("place invariants reject hidden dimensions, entrance, entity and label changes", () => {
  const before = definition();
  for (const mutate of [after => after.width++, after => after.entrance.x++, after => after.objects[0].entity_id = "new", after => after.objects[0].label = "Renamed" ]) {
    const after = structuredClone(before); mutate(after); assert.throws(() => assertUnchangedObjects(before, after, ["workshop"]));
  }
});
