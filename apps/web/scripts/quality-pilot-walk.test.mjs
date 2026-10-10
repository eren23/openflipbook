import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { derivePilotRootWalkFrame, derivePilotWalkPlan, derivePilotWalkResume, matchPilotWalkObservation, parsePilotWalkObservation, pilotRootWalkObservation, pilotWalkPulse, validatePilotWalkAutosave } from "./quality-pilot-walk.mjs";

const definition = () => ({ version: 2, width: 40, depth: 40, entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [
  { id: "workshop", kind: "building", label: "Copper Workshop", x: 22, z: 22, width: 8, depth: 10, height: 7.8, heading: 0,
    structure: { wall_thickness: 0.25, roof_height: 1.4,
      door: { id: "exterior", side: "south", offset: 1.5, width: 1.4, sill: 0, floor: 0 },
      floors: [ { id: "ground", layout: { type: "split", id: "partition", axis: "x", position: 0.5,
        door: { id: "interior", offset: 2, width: 1.2 }, a: { type: "room", id: "hall" }, b: { type: "room", id: "craft" } } },
      { id: "upper", layout: { type: "room", id: "studio" } } ] } },
] });

test("the real geometry contract places the default flight and upper landing correctly", () => {
  const plan = derivePilotWalkPlan(definition()); assert.equal(plan.supported, true);
  assert.equal(plan.stair.steps, 18); assert.equal(plan.stair.run, 4.5);
  assert.ok(Math.abs(plan.stair.level - 3.2) < 1e-9);
  assert.ok(Math.abs(plan.points.stair_bottom.x - 19.05) < 1e-9);
  assert.ok(Math.abs(plan.points.stair_top.z - 17.67) < 1e-9);
  assert.ok(Math.abs(plan.expected_upper_eye_y - 4.8) < 1e-9);
  assert.equal(plan.points.craft.z, 24); assert.equal(plan.points.hall.z, 24);
  assert.ok(plan.points.hall.x < 22.5 && plan.points.craft.x > 22.5);
});

const frameFixture = () => {
  const world = { session_id: "session_saved", place_id: "root" }, scene = { id: "scene_root", ...world, revision: 5, definition: definition() };
  const chunk = (place_id, x, z, width, depth) => ({ x, z, scene: { id: `scene_${place_id}`, session_id: world.session_id, place_id, revision: 2, definition: { version: 2, width, depth, objects: [] } } });
  return { world, scene, network: { chunks: [{ x: 0, z: 0, scene }, chunk("east", 40, 4, 24, 32), chunk("west", -16, 0, 16, 40), chunk("north", 0, -40, 40, 40)], connections: [] } };
};
test("fresh west and north chunk origins normalize measured global camera into exact saved root-local metres", () => {
  const { world, scene, network } = frameFixture(), frame = derivePilotRootWalkFrame(network, world, scene);
  assert.deepEqual(frame.origin, { x: 16, z: 40 }); assert.equal(frame.loaded_places, 4);
  const measured = pilotRootWalkObservation({ mode: "walk", camera: "36,1.6,78.8", yaw: "0", place_id: "root", loaded_places: "4" }, frame);
  assert.equal(measured.x, 20); assert.ok(Math.abs(measured.z - 38.8) < 1e-9);
  assert.deepEqual(measured.global_camera, { x: 36, y: 1.6, z: 78.8, yaw: 0 });
  const body = { request_id: "11111111-1111-4111-8111-111111111111", base_revision: 3,
    pose: { version: 1, place_id: "root", scene_revision: 5, position: { x: 20, y: 0.82, z: 38.8 }, yaw: 0, pitch: 0, space: null } };
  const original = JSON.stringify(body); assert.equal(validatePilotWalkAutosave(body, world, scene, [measured]), body.pose);
  assert.equal(JSON.stringify(body), original, "Coordinate evidence must never rewrite the actual app request");
});
test("no-network walking keeps original source-free camera and zero origin", () => {
  const { world, scene } = frameFixture(), frame = derivePilotRootWalkFrame(null, world, scene);
  assert.deepEqual(frame.origin, { x: 0, z: 0 });
  const sample = pilotRootWalkObservation({ mode: "walk", camera: "20,1.6,38.8", yaw: "0", loaded_places: "1" }, frame);
  assert.equal(sample.x, 20); assert.equal(sample.z, 38.8);
});
test("malformed network, stale root geometry and foreign world chunks cannot authorize observations", () => {
  for (const mutate of [v => { v.network.chunks[1].x = NaN; }, v => { v.network.chunks[1].scene.session_id = "other"; },
    v => { v.network.chunks[1].scene.place_id = "root"; }, v => { v.network.chunks[0].scene = { ...v.scene, revision: 4 }; },
    v => { v.network.chunks[0].scene = { ...v.scene, definition: { ...v.scene.definition, width: 41 } }; },
    v => { v.network.chunks = v.network.chunks.slice(1); }, v => { delete v.network.connections; }]) {
    const value = frameFixture(); mutate(value); assert.throws(() => derivePilotRootWalkFrame(value.network, value.world, value.scene));
  }
  const { world, scene } = frameFixture(); assert.throws(() => derivePilotRootWalkFrame(undefined, world, scene), /Malformed/);
});
test("wrong observed place, loaded network, mode or global frame fail before root autosave matching", () => {
  const { world, scene, network } = frameFixture(), frame = derivePilotRootWalkFrame(network, world, scene);
  const attrs = { mode: "walk", camera: "36,1.6,78.8", yaw: "0", place_id: "root", loaded_places: "4" };
  for (const changed of [{ place_id: "east" }, { place_id: undefined }, { loaded_places: "2" }, { mode: "orbit" }, { camera: "20,1.6,38.8" }]) {
    assert.throws(() => pilotRootWalkObservation({ ...attrs, ...changed }, frame));
  }
});

test("a structural shift changes the derived waypoints without changing saved data", () => {
  const original = definition(), moved = structuredClone(original); moved.objects[0].x += 1;
  const before = JSON.stringify(moved), a = derivePilotWalkPlan(original), b = derivePilotWalkPlan(moved);
  assert.equal(b.supported, true); assert.equal(b.points.outside.x, a.points.outside.x + 1);
  assert.equal(b.points.stair_top.x, a.points.stair_top.x + 1); assert.equal(JSON.stringify(moved), before);
});

test("unsupported geometry and blocked exterior approaches cannot become a passing plan", () => {
  for (const change of [ d => { d.objects[0].heading = 0.2; }, d => { d.objects[0].structure.footprint = []; },
    d => { d.objects[0].structure.stair = { x: -2.95, z: -1.7, direction: "east" }; },
    d => { d.objects[0].structure.floors[0].layout.axis = "z"; },
    d => { d.objects[0].structure.door.offset = -1.5; },
    d => { d.objects.push({ id: "blocker", kind: "volume", x: 23.5, z: 32, width: 3, depth: 3, heading: 0 }); } ]) {
    const d = definition(); change(d); const plan = derivePilotWalkPlan(d); assert.equal(plan.supported, false); assert.ok(plan.reason);
  }
});

test("missing or malformed live-camera observations fail closed", () => {
  assert.deepEqual(parsePilotWalkObservation("23.500,1.600,26.000", "0.0000"), { x: 23.5, y: 1.6, z: 26, yaw: 0 });
  for (const [camera, yaw] of [[null, "0"], ["1,,2", "0"], ["1,2,3", ""], ["1,Infinity,3", "0"]]) {
    assert.throws(() => parsePilotWalkObservation(camera, yaw));
  }
});

test("saved south-exterior positions resume through checked movement waypoints; no teleport", () => {
  const d = definition(), plan = derivePilotWalkPlan(d), observed = { x: 23.3, y: 1.6, z: 38.8 };
  assert.deepEqual(derivePilotWalkResume(d, plan, observed), { supported: true, waypoints: [{ x: 20, z: 38.8 }, { x: 20, z: 38.8 }] });
  assert.equal(derivePilotWalkResume(d, plan, { x: 23.3, y: 1.6, z: 26 }).supported, false);
  assert.equal(derivePilotWalkResume(d, plan, { ...observed, y: 4.8 }).supported, false);
  d.objects.push({ id: "block", kind: "volume", x: 21.5, z: 38.8, width: 1, depth: 1, heading: 0 });
  assert.equal(derivePilotWalkResume(d, plan, observed).supported, false);
});

test("lagged app autosaves match recent measured history, not a later moving frame", () => {
  // Actual failed trace: pose x21.933 queued while later camera was past x23.
  const now = Date.now(), pose = { position: { x: 21.933, y: 0.82, z: 38.799 }, yaw: 0 };
  const earlier = { x: 21.85, y: 1.6, z: 38.799, yaw: 0, observed_at: now - 700 };
  const current = { ...earlier, x: 23.2, observed_at: now };
  assert.equal(matchPilotWalkObservation(pose, [earlier, current], now), earlier);
  assert.equal(matchPilotWalkObservation(pose, [current], now), null);
  assert.equal(matchPilotWalkObservation(pose, [{ ...earlier, observed_at: now - 6001 }], now), null);
  assert.equal(matchPilotWalkObservation(pose, [{ ...earlier, observed_at: now + 1000 }], now), null);
  assert.equal(matchPilotWalkObservation({ ...pose, position: { ...pose.position, y: 4.02 } }, [earlier], now), null);
});

test("the live overshoot is corrected by opposite real input with bounded key-up precision", () => {
  // Preserved second live attempt: x target23.5, actual23.854, not an injected pose.
  assert.deepEqual(pilotWalkPulse("x", 23.5 - 23.854), { key: "a", delay: 60 });
  assert.deepEqual(pilotWalkPulse("z", -0.16), { key: "w", delay: 30 });
  assert.deepEqual(pilotWalkPulse("x", 0.16), { key: "d", delay: 30 });
  assert.deepEqual(pilotWalkPulse("z", 0.4), { key: "s", delay: 60 });
  assert.equal(pilotWalkPulse("x", 0.05), null);
  for (const remaining of [-10, -0.4, -0.08, 0.08, 0.4, 10]) assert.ok(pilotWalkPulse("x", remaining).delay * 2.5 / 1000 <= 0.15);
  assert.throws(() => pilotWalkPulse("y", 1)); assert.throws(() => pilotWalkPulse("x", NaN));
});

test("an app autosave must match the owned scene and a measured physics camera", () => {
  const scene = { revision: 2, definition: definition() }, world = { place_id: "place" };
  const body = { request_id: "11111111-1111-4111-8111-111111111111", base_revision: 0,
    pose: { version: 1, place_id: "place", scene_revision: 2, position: { x: 23.5, y: 0.82, z: 26 }, yaw: 0, pitch: 0, space: { building_id: "workshop", floor_id: "ground", room_id: "craft" } } };
  const camera = { x: 23.5, y: 1.6, z: 26, yaw: 0 };
  assert.deepEqual(validatePilotWalkAutosave(body, world, scene, camera), body.pose);
  for (const change of [ b => { b.pose.place_id = "another"; }, b => { b.pose.scene_revision = 1; },
    b => { b.pose.position.y = 4.02; }, b => { b.pose.position.x += 2; }, b => { b.pose.yaw = 1; } ]) {
    const b = structuredClone(body); change(b); assert.throws(() => validatePilotWalkAutosave(b, world, scene, camera));
  }
});

test("the walkthrough has no pose injection or synthetic write API", async () => {
  const source = await readFile(new URL("./quality-pilot-walk.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /page\.request\.post|setNextKinematicTranslation|setTranslation|camera\.position\.set|routeQuery|\/motion\/|generate_keyframe/);
  assert.match(source, /viewport\.evaluate\(element => \(\{ mode: element\.dataset\.mode, camera: element\.dataset\.camera,\s*yaw: element\.dataset\.yaw, place_id: element\.dataset\.placeId, loaded_places: element\.dataset\.loadedPlaces \}\)\)/);
  assert.match(source, /page\.keyboard\.down\(key\)/); assert.match(source, /route\.fetch\(\{ maxRedirects: 0 \}\)/);
});
