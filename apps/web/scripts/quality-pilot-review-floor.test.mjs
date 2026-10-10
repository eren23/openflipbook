import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePilotReviewTargets, pilotReviewAllowsMethod, pilotReviewHash, validatePilotReviewEnvironment } from "./quality-pilot-review-floor.mjs";

const definition = () => ({ version: 2, objects: [
  { id: "workshop", kind: "building", label: "Copper Workshop", structure: { floors: [{ id: "ground" }, { id: "upper" }] } },
  { id: "chair", kind: "mesh", label: "Carved Wooden Chair", mesh_role: "prop", asset_id: "chair-asset", placement: { building_id: "workshop", floor_id: "upper" } },
  { id: "kiosk", kind: "mesh", label: "Garden Kiosk", mesh_role: "exterior", asset_id: "kiosk-asset" },
  { id: "bench", kind: "bench", label: "Work Bench", placement: { building_id: "workshop", floor_id: "upper" } },
] });
const context = () => {
  const receipt = { version: 1, kind: "quality-pilot", project: "ofb-pilot-0123456789ab", database: "quality_pilot", evidence_dir: "/private/pilot", state: "running", origin: "http://127.0.0.1:32001" };
  const manifest = { ...receipt, world: { session_id: "session_saved", place_id: "place_root" }, phases: { capture: { status: "complete" } } };
  return { receipt, manifest };
};

test("read-only review denies all writes, including preflight and provider submissions", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "get"]) assert.equal(pilotReviewAllowsMethod(method), false);
  for (const method of ["GET", "HEAD"]) assert.equal(pilotReviewAllowsMethod(method), true);
});
test("canonical before/after evidence ignores key order while detecting geometry and saved position changes", () => {
  assert.equal(pilotReviewHash({ revision: 2, definition: { width: 40, depth: 40 } }), pilotReviewHash({ definition: { depth: 40, width: 40 }, revision: 2 }));
  assert.notEqual(pilotReviewHash({ revision: 2, definition: { width: 40 } }), pilotReviewHash({ revision: 2, definition: { width: 41 } }));
  assert.notEqual(pilotReviewHash({ pose: { x: 20, z: 38 } }), pilotReviewHash({ pose: { x: 21, z: 38 } }));
});
test("review binds generated chair to saved upper floor and kiosk to outdoors, including upper furniture", () => {
  const targets = derivePilotReviewTargets(definition());
  assert.equal(targets.upper.id, "upper"); assert.equal(targets.chair.id, "chair"); assert.equal(targets.kiosk.id, "kiosk");
  assert.deepEqual(targets.furniture.map(object => object.id), ["bench"]);
});
test("wrong floor, wrong role and ambiguous mesh targets fail closed", () => {
  const wrongFloor = definition(); wrongFloor.objects[1].placement.floor_id = "ground";
  assert.throws(() => derivePilotReviewTargets(wrongFloor), /upper floor/);
  const wrongRole = definition(); wrongRole.objects[2].mesh_role = "prop";
  assert.throws(() => derivePilotReviewTargets(wrongRole), /Garden Kiosk/);
  const ambiguous = definition(); ambiguous.objects.push({ ...ambiguous.objects[1], id: "chair2" });
  assert.throws(() => derivePilotReviewTargets(ambiguous), /Exactly one generated prop/);
});
test("review refuses remote stores, altered pilot ownership and unfinished capture", () => {
  const valid = context(); assert.equal(validatePilotReviewEnvironment(valid.receipt, "/private/pilot/environment.json", valid.manifest), valid.receipt);
  for (const changed of [
    { origin: "https://production.example" }, { origin: "http://localhost:32001" },
    { origin: "http://owner:secret@127.0.0.1:32001" }, { origin: "http://127.0.0.1:32001/?token=secret" },
    { database: "production" }, { evidence_dir: "/other/pilot" },
  ]) { const { receipt, manifest } = context(); Object.assign(receipt, changed); assert.throws(() => validatePilotReviewEnvironment(receipt, "/private/pilot/environment.json", manifest)); }
  const { receipt, manifest } = context(); manifest.world.session_id = "other/world";
  assert.throws(() => validatePilotReviewEnvironment(receipt, "/private/pilot/environment.json", manifest), /ownership/);
  const unfinished = context(); unfinished.manifest.phases.capture.status = "running";
  assert.throws(() => validatePilotReviewEnvironment(unfinished.receipt, "/private/pilot/environment.json", unfinished.manifest), /physical capture/);
});
