import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveLongWalkPlan, deriveLongWalkRecovery, exportLongWalkSamples, longWalkAxisCorrection, longWalkChromiumOptions, longWalkDefinitionReceipt, longWalkBoundaryProof, longWalkOverview, mergeLongWalkObservations, validateLongWalkEnvironment, validateLongWalkAutosave } from "./quality-pilot-long-walk.mjs";

const world = { session_id: "session_demo", place_id: "place_root" };

test("sidecar retains the final actual pose per timestamp and receipts every dropped observation without changing history", () => {
  const p = { elapsed_seconds: 1, x: 16.011, y: 1.6, z: 60, yaw: 1.57, pitch: 0, place_id: "place_root" };
  const observations = [p, { ...p, x: 15.991, place_id: "west" }, { ...p, x: 15.987, place_id: "west" },
    { ...p, elapsed_seconds: 1.001, x: 15.96, place_id: "west" }, { ...p, elapsed_seconds: 1.001, x: 15.94, place_id: "west" },
    { ...p, elapsed_seconds: 2, x: 14, place_id: "west" }];
  const original = structuredClone(observations), result = exportLongWalkSamples(observations);
  assert.deepEqual(observations, original);
  assert.deepEqual(result.samples.map(s => [s.seconds, s.position[0], s.place_id]), [[1, 15.987, "west"], [1.001, 15.94, "west"], [2, 14, "west"]]);
  assert.equal(result.provenance.input_observations, 6); assert.equal(result.provenance.exported_samples, 3);
  assert.equal(result.provenance.coalesced_observations, 3); assert.equal(result.provenance.duplicate_timestamp_groups, 2);
  assert.equal(result.provenance.policy, "last_actual_observation_per_timestamp");
  assert.deepEqual(result.provenance.coalesced[0].discarded.map(d => [d.observation_index, d.sample.position[0]]), [[0, 16.011], [1, 15.991]]);
  assert.equal(result.provenance.coalesced[0].selected.observation_index, 2);
  assert.deepEqual(result.provenance.coalesced[0].selected.sample, result.samples[0]);
  for (let i = 1; i < result.samples.length; i++) assert.ok(result.samples[i].seconds > result.samples[i - 1].seconds);
});

test("sidecar coalescing cannot invent times, accept invalid poses or silently reorder history", () => {
  const p = { elapsed_seconds: 1, x: 20, y: 1.6, z: 60, yaw: 0, pitch: 0, place_id: "place_root" };
  assert.deepEqual(exportLongWalkSamples([]).samples, []);
  assert.throws(() => exportLongWalkSamples([p, { ...p, elapsed_seconds: 0 }]), /time order/);
  assert.throws(() => exportLongWalkSamples([{ ...p, elapsed_seconds: -1 }]), /finite recorded/);
  assert.throws(() => exportLongWalkSamples([{ ...p, pitch: NaN }]), /finite recorded/);
  assert.equal(exportLongWalkSamples([p, { ...p }]).samples.length, 1);
});

test("route geometry hashes match GLB raw JSON while separately retaining canonical definition checksums", () => {
  const a = { version: 2, objects: [{ id: "building", width: 7 }], label: "Saved place" };
  const b = { label: "Saved place", objects: [{ width: 7, id: "building" }], version: 2 };
  const first = longWalkDefinitionReceipt(a), second = longWalkDefinitionReceipt(b);
  assert.equal(first.definition_sha256, createHash("sha256").update(JSON.stringify(a), "utf8").digest("hex"));
  assert.equal(first.definition_sha256_algorithm, "sha256_utf8_json_stringify");
  assert.notEqual(first.definition_sha256, second.definition_sha256);
  assert.equal(first.canonical_definition_sha256, second.canonical_definition_sha256);
  assert.equal(first.canonical_definition_sha256_algorithm, "sha256_utf8_recursive_sorted_json");
  assert.notEqual(first.canonical_definition_sha256, longWalkDefinitionReceipt({ ...a, label: "Changed" }).canonical_definition_sha256);
});

test("macOS selects Metal while other Chromium launch platforms retain their defaults", () => {
  assert.deepEqual(longWalkChromiumOptions("darwin"), { headless: true, slowMo: 0, args: ["--use-angle=metal"] });
  assert.deepEqual(longWalkChromiumOptions("linux"), { headless: true, slowMo: 0 });
});

test("bounded near-target keyboard corrections converge at both full and slow physical frame rates", () => {
  for (const initial of [-0.4, -0.2, 0.16, 0.25, 0.4]) for (const advance of [0.025, 0.08, 0.2, 0.3]) {
    let remaining = initial, presses = 0, correction;
    while ((correction = longWalkAxisCorrection(remaining)) && presses++ < 20) {
      assert.equal(correction.delay_ms, 120);
      remaining -= (correction.key === "w" ? 1 : -1) * advance;
    }
    assert.ok(presses < 20); assert.ok(Math.abs(remaining) <= 0.15);
    assert.ok(Math.hypot(remaining, remaining) < 0.3);
  }
  assert.throws(() => longWalkAxisCorrection(NaN));
});
const house = (id, label, x, z, width, depth, side = "south") => ({ id, kind: "building", label, x, z, width, depth, height: 4.6, heading: 0,
  structure: { wall_thickness: 0.25, roof_height: 1.4, floors: [{ id: `${id}_floor`, label: "Ground Floor" }],
    door: { id: `${id}_door`, side, offset: 0, width: 1.4, height: 2.3, floor: 0, sill: 0 } } });
const fixture = () => {
  const workshop = house("workshop", "Copper Workshop", 23, 22, 8, 10); workshop.height = 7.8;
  workshop.structure.door.offset = 1.5;
  workshop.structure.floors = [{ id: "ground", label: "Ground Floor", layout: { type: "split", id: "partition", axis: "x", position: 0.5,
    door: { id: "partition_door", offset: 2, width: 1.2, height: 2.2 }, a: { type: "room", id: "hall", label: "Stair Hall" }, b: { type: "room", id: "craft", label: "Craft Room" } } },
  { id: "upper", label: "Upper Loft", layout: { type: "room", id: "studio", label: "Master Studio" } }];
  const chunk = (id, label, x, z, width, depth, objects, entranceX = 20) => ({ x, z, scene: { id: `scene_${id}`, session_id: world.session_id, place_id: id, revision: 2,
    definition: { version: 2, label, width, depth, objects, entrance: { x: entranceX, z: depth - 1.2, yaw: 0 } } } });
  return { chunks: [chunk("place_root", "Copper Workshop quality pilot", 0, 0, 40, 40,
    [workshop, house("bakery", "Old Town Bakery", 9, 24, 6, 7), house("bookshop", "Corner Bookshop", 25, 9, 7, 6)]),
  chunk("west", "Clockmakers Western Lane", -16, 0, 16, 40, [house("guild", "Clockmakers Guild", 4.5, 7.5, 7, 7.5), house("lodge", "Workshop Lodge", 4.5, 29.5, 7, 9, "north")], 8),
  chunk("annex", "Canal Garden Annex", 40, 4, 24, 32, [house("tea", "Canal Tea House", 17.5, 8.5, 7, 7), house("tool", "Tool Store", 5.5, 7.5, 6, 5)], 12),
  chunk("north", "Contemporary Civic Garden", 0, -40, 40, 40, [house("reading", "Civic Reading Hall", 20, 12, 14, 10)])],
  connections: [["west_link", "west", "west", "east", 20, 20], ["east_link", "annex", "east", "west", 20, 16], ["north_link", "north", "north", "south", 20, 20]]
    .map(([id, target, side, other, offset, targetOffset]) => ({ id, version: 1, kind: "boundary", width: 3, a: { place_id: world.place_id, side, offset }, b: { place_id: target, side: other, offset: targetOffset } })) };
};

test("long route covers all four saved places, five actual interiors, upper floor and at least 400 metres", () => {
  const plan = deriveLongWalkPlan(fixture(), world);
  assert.ok(plan.planned_metres > 400 && plan.planned_metres < 650);
  assert.equal(new Set(plan.points.map(p => p.place_id)).size, 4);
  assert.equal(new Set(plan.points.map(p => p.space?.building_id).filter(Boolean)).size, 5);
  const upper = plan.points.find(p => p.label === "workshop-upper-studio"); assert.equal(upper.space.floor_id, "upper"); assert.equal(upper.space.room_id, "studio");
  assert.ok(Math.abs(upper.y - 4.8) < 1e-9);
  assert.deepEqual([plan.points[0].x, plan.points[0].z], [36, 78.8]);
  assert.deepEqual([plan.points.at(-1).x, plan.points.at(-1).z], [36, 78.8]);
});

test("route derivation rejects mismatched saved boundary alignment and missing places", () => {
  const network = fixture(); network.connections[0].b.offset = 21;
  assert.throws(() => deriveLongWalkPlan(network, world), /do not align/);
  assert.throws(() => deriveLongWalkPlan({ ...fixture(), chunks: fixture().chunks.slice(0, 3) }, world), /four/);
});

test("changed shell or blocked physical lane cannot silently become a valid route", () => {
  const network = fixture(); network.chunks[0].scene.definition.objects.push({ id: "barrier", label: "Saved barrier", kind: "bench", x: 4, z: 32, width: 2, depth: 2, height: 1, heading: 0 });
  assert.throws(() => deriveLongWalkPlan(network, world), /Saved barrier blocks/);
  const altered = fixture(); altered.chunks[1].scene.definition.objects[0].structure.door.side = "east";
  assert.throws(() => deriveLongWalkPlan(altered, world));
});

test("saved floor furniture blocking upper room is rejected before walking", () => {
  const network = fixture(); network.chunks[0].scene.definition.objects.push({ id: "upper_barrier", label: "Upper barrier", kind: "bench", x: -1.2, z: -1.7, width: 2, depth: 2, height: 1, heading: 0,
    placement: { building_id: "workshop", floor_id: "upper" } });
  assert.throws(() => deriveLongWalkPlan(network, world), /Interior Upper barrier blocks/);
});

test("overview distinguishes planned route from measured observations and escapes labels", () => {
  const network = fixture(); network.chunks[0].scene.definition.objects[0].label = "Copper Workshop";
  network.chunks[0].scene.definition.objects[1].label = '<script>alert("x")</script>';
  const plan = deriveLongWalkPlan(network, world), svg = longWalkOverview(plan, [{ x: 36, z: 78.8 }, { x: 36.1, z: 78.7 }]);
  assert.ok(svg.includes("36,78.8 36.1,78.7")); assert.ok(svg.includes("observed physics camera"));
  assert.ok(svg.includes("&lt;script&gt;")); assert.ok(!svg.includes("<script>"));
});

test("all boundary proofs require actual forward and return positions at the opening", () => {
  const plan = deriveLongWalkPlan(fixture(), world), observations = [];
  for (const portal of Object.values(plan.portals)) observations.push({ ...portal, place_id: portal.places[0] }, { ...portal, place_id: portal.places[1] }, { ...portal, place_id: portal.places[0] });
  assert.ok(Object.values(longWalkBoundaryProof(plan, observations)).every(p => p.forward_and_return));
  assert.ok(Object.values(longWalkBoundaryProof(plan, [])).every(p => !p.forward_and_return));
  const portal = plan.portals.west;
  assert.throws(() => longWalkBoundaryProof(plan, [{ ...portal, place_id: portal.places[0] }, { ...portal, x: portal.x + 20, place_id: portal.places[1] }]), /away/);
});

test("the actual first-west queued save matches its adjacent root frame without relaxing distance, yaw or history age", () => {
  const plan = deriveLongWalkPlan(fixture(), world), now = Date.now();
  const body = { request_id: "b5ccaa68-4fc7-4ff7-8bfb-fcb1a60b11ff", base_revision: 376,
    pose: { version: 1, place_id: "west", scene_revision: 2, position: { x: 15.982, y: 0.827, z: 20.05 }, yaw: 1.5707928466796883, pitch: 0, space: null } };
  const sample = { x: 16.291, y: 1.6, z: 60.05, yaw: 1.5708, place_id: "place_root", observed_at: now - 800 };
  const checked = validateLongWalkAutosave(body, plan, [sample, { ...sample, x: 15.239, place_id: "west", observed_at: now - 200 }]);
  assert.equal(checked.cross_boundary_history, true); assert.equal(checked.matched_local_camera.observed_place_id, "place_root");
  assert.throws(() => validateLongWalkAutosave(body, plan, [{ ...sample, x: 16.7 }]), /physics camera history/);
  assert.throws(() => validateLongWalkAutosave(body, plan, [{ ...sample, yaw: 0 }]), /physics camera history/);
  assert.throws(() => validateLongWalkAutosave(body, plan, [{ ...sample, observed_at: now - 7000 }]), /physics camera history/);
  assert.throws(() => validateLongWalkAutosave({ ...body, pose: { ...body.pose, scene_revision: 3 } }, plan, [sample]), /owned saved scene/);
});

test("adjacent history cannot authorize saves off the actual opening or across an unconnected place", () => {
  const plan = deriveLongWalkPlan(fixture(), world), body = { request_id: "b5ccaa68-4fc7-4ff7-8bfb-fcb1a60b11ff", base_revision: 376,
    pose: { version: 1, place_id: "west", scene_revision: 2, position: { x: 15.982, y: 0.82, z: 23 }, yaw: 1.57, pitch: 0, space: null } };
  const sample = { x: 16.291, y: 1.6, z: 63, yaw: 1.57, place_id: "place_root", observed_at: Date.now() };
  assert.throws(() => validateLongWalkAutosave(body, plan, [sample]), /physics camera history/);
  assert.throws(() => validateLongWalkAutosave({ ...body, pose: { ...body.pose, position: { ...body.pose.position, z: 20 } } }, plan,
    [{ ...sample, z: 60, place_id: "annex" }]), /physics camera history/);
});

test("known stopped root-west exterior resumes only through checked physical recovery waypoints", () => {
  const plan = deriveLongWalkPlan(fixture(), world);
  const observed = { x: 18.721, y: 1.6, z: 60.053, place_id: "place_root" };
  const points = deriveLongWalkRecovery(plan, observed); assert.equal(points.length, 4);
  assert.deepEqual([points[0].x, points[0].z], [20, 60.053]); assert.deepEqual([points.at(-1).x, points.at(-1).z], [36, 78.8]);
  assert.deepEqual(deriveLongWalkRecovery(plan, { ...plan.points[0], y: 1.6 }), []);
  for (const patch of [{ place_id: "west" }, { x: 32 }, { z: 70 }, { y: 4.8 }]) assert.throws(() => deriveLongWalkRecovery(plan, { ...observed, ...patch }));
  plan.chunks[0].scene.definition.objects.push({ id: "recovery_barrier", label: "Recovery barrier", kind: "bench", x: 4, z: 32, width: 2, depth: 2, height: 1, heading: 0 });
  assert.throws(() => deriveLongWalkRecovery(plan, observed), /blocks the physical recovery/);
});

test("passive actual intermediate yaw frames survive sparse CDP reads without relaxing the saved-pose guard", () => {
  const plan = deriveLongWalkPlan(fixture(), world), now = Date.now(), report = { observations: [] };
  const raw = (yaw, at) => ({ mode: "walk", loaded_places: "4", camera: "18.721,1.600,60.053", yaw: String(yaw),
    direction: `${-Math.sin(yaw)},0,${-Math.cos(yaw)}`, place_id: "place_root", observed_at: at });
  const intermediate = raw(-2.192392460499896, now - 4000), last = raw(-1.7123853071795863, now);
  mergeLongWalkObservations(report, [raw(-2.3123853071795866, now - 8500), intermediate, last], plan, now - 10_000);
  mergeLongWalkObservations(report, [intermediate, last], plan, now - 10_000);
  assert.equal(report.observations.length, 3); assert.ok(report.observations[0].observed_at < report.observations[1].observed_at);
  const body = { request_id: "ec952200-e660-4064-bc27-22e2a7f96208", base_revision: 381,
    pose: { version: 1, place_id: "place_root", scene_revision: 2, position: { x: 2.721, y: 0.82, z: 20.053 }, yaw: -2.192392460499896, pitch: 0, space: null } };
  assert.equal(validateLongWalkAutosave(body, plan, report.observations).matched_local_camera.yaw, intermediate.yaw * 1);
  assert.throws(() => validateLongWalkAutosave(body, plan, report.observations.filter(p => p.observed_at !== intermediate.observed_at)), /physics camera history/);
});

test("rendered direction records real nonzero pitch and rejects inconsistent camera samples", () => {
  const plan = deriveLongWalkPlan(fixture(), world), report = { observations: [] }, pitch = 0.2;
  const raw = { mode: "walk", loaded_places: "4", camera: "36,1.600,78.8", yaw: "0", direction: `0,${Math.sin(pitch)},${-Math.cos(pitch)}`,
    place_id: "place_root", observed_at: Date.now() };
  assert.ok(Math.abs(mergeLongWalkObservations(report, [raw], plan, raw.observed_at).pitch - pitch) < 1e-12);
  assert.throws(() => mergeLongWalkObservations(report, [{ ...raw, direction: "0,0,0" }], plan, raw.observed_at), /unit direction/);
  assert.throws(() => mergeLongWalkObservations(report, [{ ...raw, yaw: "1" }], plan, raw.observed_at), /yaw disagree/);
});

test("only explicit running provider-disabled clone receipts and separate private state are allowed", () => {
  const receipt = { version: 1, kind: "long-walk-demo", state: "running", origin: "http://127.0.0.1:43210", providers_disabled: true, worker_disabled: true,
    evidence_dir: "/tmp/long-walk-new", browser_state_file: "/tmp/long-walk-new/browser-state.json", world };
  assert.equal(validateLongWalkEnvironment(receipt, "/tmp/long-walk-new/environment.json"), receipt);
  for (const patch of [{ kind: "quality-pilot" }, { providers_disabled: false }, { worker_disabled: false }, { state: "stopped" },
    { origin: "https://example.com" }, { evidence_dir: "/tmp/original-pilot" }, { world: { session_id: "../other", place_id: "place_root" } }]) {
    assert.throws(() => validateLongWalkEnvironment({ ...receipt, ...patch }, "/tmp/long-walk-new/environment.json"));
  }
});
