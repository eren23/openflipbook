import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { derivePilotConnectedWalkPlan, normalizedPilotChunks, pilotConnectedSpace, validatePilotConnectedAutosave } from "./quality-pilot-connected-walk.mjs";

const scene = (place_id, definition) => ({ id: `scene_${place_id}`, place_id, revision: 2, definition: { version: 2, ...definition } });
const network = () => ({ chunks: [
  { x: -20, z: -12, scene: scene("root", { width: 40, depth: 40, entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [
    { id: "workshop", kind: "building", label: "Copper Workshop", x: 22, z: 22, width: 8, depth: 10, height: 7.8, heading: 0 },
  ] }) },
  { x: 20, z: -8, scene: scene("annex", { width: 24, depth: 32, entrance: { x: 12, z: 30.8, yaw: 0 }, objects: [
    { id: "tea", kind: "building", label: "Canal Tea House", x: 17.5, z: 8.5, width: 7, depth: 7, height: 4.6, heading: 0,
      structure: { wall_thickness: 0.25, roof_height: 1.4, floors: [{ id: "tea_floor", label: "Tea Lounge" }],
        door: { id: "tea_door", side: "south", offset: 0, width: 1.4, height: 2.3, sill: 0, floor: 0 } } },
  ] }) },
], connections: [{ id: "east_link", version: 1, kind: "boundary", a: { place_id: "root", side: "east", offset: 20 }, b: { place_id: "annex", side: "west", offset: 16 }, width: 3 }] });
const body = () => ({ request_id: "11111111-1111-4111-8111-111111111111", base_revision: 5,
  pose: { version: 1, place_id: "annex", scene_revision: 2, position: { x: 17.5, y: 0.82, z: 10.5 }, yaw: 0, pitch: 0,
    space: { building_id: "tea", floor_id: "tea_floor" } } });
const observation = (place_id = "annex") => ({ x: 57.5, y: 1.6, z: 14.5, yaw: 0, place_id, observed_at: Date.now() });

test("route derives saved portal, floor, doorway and globally normalized points", () => {
  const plan = derivePilotConnectedWalkPlan(network(), "root"); assert.equal(plan.supported, true, plan.reason);
  assert.deepEqual(plan.portal, { x: 40, z: 20 }); assert.equal(plan.floor_id, "tea_floor"); assert.equal(plan.room_id, undefined);
  assert.deepEqual(plan.points.map(point => [point.x, point.z]), [[20, 38.8], [36, 38.8], [36, 20], [41, 20], [57.5, 20], [57.5, 17], [57.5, 14.5]]);
  const changed = network(); changed.chunks[1].scene.definition.objects[0].structure.door.offset = -0.5;
  assert.equal(derivePilotConnectedWalkPlan(changed, "root").points.at(-1).x, 57);
});
test("additional western chunk shifts actual global camera coordinates without changing local poses", () => {
  const extended = network(); extended.chunks.push({ x: -60, z: -12, scene: scene("west", { width: 40, depth: 40, entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [] }) });
  const plan = derivePilotConnectedWalkPlan(extended, "root"); assert.equal(plan.supported, true, plan.reason);
  assert.equal(plan.points[0].x, 60); assert.equal(plan.points.at(-1).x, 97.5);
  const saved = validatePilotConnectedAutosave(body(), plan.chunks, [{ ...observation(), x: 97.5 }]);
  assert.equal(saved.matched_local_camera.x, 17.5); assert.equal(saved.matched_local_camera.z, 10.5);
});
test("current obstacles anywhere in the full network and invalid saved openings fail closed", () => {
  const blocked = network(); blocked.chunks[0].scene.definition.objects.push({ id: "new_store", kind: "building", label: "New Store", x: 36, z: 30, width: 4, depth: 4, height: 4, heading: 0 });
  assert.match(derivePilotConnectedWalkPlan(blocked, "root").reason, /New Store blocks/);
  const misaligned = network(); misaligned.connections[0].b.offset = 15;
  assert.equal(derivePilotConnectedWalkPlan(misaligned, "root").supported, false);
  const wrongDoor = network(); wrongDoor.chunks[1].scene.definition.objects[0].structure.door.side = "east";
  assert.equal(derivePilotConnectedWalkPlan(wrongDoor, "root").supported, false);
  const blockedInterior = network(); blockedInterior.chunks[1].scene.definition.objects.push({ id: "box", kind: "bench", label: "Door Box", x: 0, z: 2.1, width: 1, depth: 1, height: 1, heading: 0, placement: { building_id: "tea", floor_id: "tea_floor" } });
  assert.match(derivePilotConnectedWalkPlan(blockedInterior, "root").reason, /Door Box blocks/);
});
test("global observed history converts to local autosave and enforces exact scene, place and space", () => {
  const chunks = normalizedPilotChunks(network()); const valid = validatePilotConnectedAutosave(body(), chunks, [observation()]);
  assert.deepEqual(valid.pose.space, { building_id: "tea", floor_id: "tea_floor" });
  const stale = body(); stale.pose.scene_revision = 1; assert.throws(() => validatePilotConnectedAutosave(stale, chunks, [observation()]), /owned saved scene/);
  const foreign = body(); foreign.pose.place_id = "production"; assert.throws(() => validatePilotConnectedAutosave(foreign, chunks, [observation()]), /owned connected place/);
  const wrongSpace = body(); wrongSpace.pose.space = null; assert.throws(() => validatePilotConnectedAutosave(wrongSpace, chunks, [observation()]), /authoritative local geometry/);
  assert.throws(() => validatePilotConnectedAutosave(body(), chunks, [observation("root")]), /physics camera history/);
  assert.throws(() => validatePilotConnectedAutosave(body(), chunks, [{ ...observation(), x: 17.5, z: 10.5 }]), /physics camera history/);
});
test("queued boundary autosave matches its recent owned-place frame, rejecting expired or invented history", () => {
  const chunks = normalizedPilotChunks(network()), saved = body(); saved.pose.position = { x: 1, y: 0.82, z: 16 }; saved.pose.space = null;
  const history = [{ x: 41, y: 1.6, z: 20, yaw: 0, place_id: "annex", observed_at: Date.now() - 1500 },
    { x: 43, y: 1.6, z: 20, yaw: 0, place_id: "annex", observed_at: Date.now() }];
  assert.equal(validatePilotConnectedAutosave(saved, chunks, history).matched_local_camera.x, 1);
  assert.throws(() => validatePilotConnectedAutosave(saved, chunks, history.map(sample => ({ ...sample, observed_at: Date.now() - 7000 }))), /physics camera history/);
});
test("space proof follows room IDs when present and does not invent a room for an unpartitioned saved floor", () => {
  const d = network().chunks[1].scene.definition;
  assert.deepEqual(pilotConnectedSpace(d, body().pose.position), { building_id: "tea", floor_id: "tea_floor" });
  d.objects[0].structure.floors[0].layout = { type: "room", id: "tea_room", label: "Tea Room" };
  assert.deepEqual(pilotConnectedSpace(d, body().pose.position), { building_id: "tea", floor_id: "tea_floor", room_id: "tea_room" });
  assert.equal(pilotConnectedSpace(d, { x: 1, y: 0.82, z: 16 }), null);
});
test("foreign-world chunks cannot authorize scoped saved position writes", () => {
  const own = network(); for (const chunk of own.chunks) chunk.scene.session_id = "session_saved";
  assert.equal(normalizedPilotChunks(own, "session_saved").length, 2);
  own.chunks[1].scene.session_id = "session_other";
  assert.throws(() => normalizedPilotChunks(own, "session_saved"), /another world session/);
});
test("connected proof has genuine controls and no pose injection, manual POST or manifest rewrite", async () => {
  const source = await readFile(new URL("./quality-pilot-connected-walk.mjs", import.meta.url), "utf8");
  for (const forbidden of [/\.request\.post\s*\(/, /\.setNextKinematicTranslation\s*\(/, /\.setTranslation\s*\(/,
    /\.position\.set\s*\(/, /Return to entrance/, /saveJson\([^\n]*pilot-manifest/, /atomicJson\([^\n]*pilot-manifest/]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /page\.keyboard\.press/); assert.match(source, /page\.mouse\.move/);
  assert.match(source, /route\.fetch\(\{ maxRedirects: 0 \}\)/);
});
