import assert from "node:assert/strict";
import test from "node:test";
import { checkQuote, checkTextQuote, checkTextContext, jsonHash, pilotBrowserSlowMo, prepareAction, requireReview, reservedPilotUsd, reservePhase, validateEnvironment, validatePlan } from "./run-quality-pilot.mjs";

const text = { model: "google/gemini-3.7-flash", reservation: .2, parameters: { max_tokens: 16384 } };
const quote = { cap_usd: 5, expires_at: "2099-01-01T00:00:00Z", phases: { layout: { max_reservation: .2, models: { layout: text } }, appearance: { max_reservation: 1.94, models: {} }, replay: { max_reservation: 0, models: {} } } };
const receipt = () => ({ version: 1, kind: "quality-pilot", project: "ofb-pilot-123456abcdef", database: "quality_pilot", live_providers: true, fixture_providers: false,
  state: "running", origin: "http://127.0.0.1:40433", evidence_dir: "/private/pilot", approved_phases: ["layout", "appearance", "replay"], cap_usd: 5, quote, quote_sha256: jsonHash(quote) });
const ledger = () => ({ cap_usd: 5, phases: {}, actions: {} });

test("capture and replay walking use real feedback without per-RPC slowdown", () => {
  assert.equal(pilotBrowserSlowMo("capture"), 0); assert.equal(pilotBrowserSlowMo("replay"), 0);
  for (const phase of ["layout", "appearance", "furnishing", "edit", "expansion", "illustration", "motion"]) assert.equal(pilotBrowserSlowMo(phase), 100);
});

test("accepts only a running live isolated environment with current exact quote bytes", () => {
  assert.equal(validateEnvironment(receipt(), "layout").cap_usd, 5);
  for (const patch of [{ fixture_providers: true }, { live_providers: false }, { database: "production" }, { state: "prepared" }, { origin: "https://example.com" }, { quote_sha256: "changed" }, { approved_phases: [] }]) assert.throws(() => validateEnvironment({ ...receipt(), ...patch }, "layout"));
  const expired = { ...quote, expires_at: "2020-01-01T00:00:00Z" }; assert.throws(() => validateEnvironment({ ...receipt(), quote: expired, quote_sha256: jsonHash(expired) }, "layout"), /expired/);
});
test("refuses an aggregate quote above the cap before a phase is reserved", () => {
  const expensive = { ...quote, phases: { layout: { max_reservation: 5.000001 } } };
  assert.throws(() => validateEnvironment({ ...receipt(), quote: expensive, quote_sha256: jsonHash(expensive) }, "layout"), /envelope/);
});
test("run reservation never resets across dates and reserves an existing phase only once", () => {
  const manifest = ledger(), old = reservePhase(manifest, "layout", quote.phases.layout, "oldquote"); old.created_at = "2000-01-01";
  assert.equal(reservePhase(manifest, "layout", quote.phases.layout, "newquote"), old);
  assert.throws(() => reservePhase(manifest, "other", { max_reservation: 4.800001 }, "quote"), /exhausted/);
  assert.throws(() => reservePhase(manifest, "layout", { ...quote.phases.layout, max_reservation: .3 }, "quote"), /changed/);
  assert.equal(Object.keys(manifest.phases).length, 1);
});
test("existing and new ordinary phases include extension holds in the same cap and reported total", () => {
  const approval = { max_reservation: 0.8, models: {} }, manifest = { cap_usd: 5, phases: { earlier: { reserved_usd: 3.24 } }, extension_phases: { growth_west: { reserved_usd: 0.2 }, growth_north: { reserved_usd: 0.2 } } };
  const saved = reservePhase(manifest, "motion", approval, "parent"); assert.equal(reservedPilotUsd(manifest), 4.44); assert.equal(reservePhase(manifest, "motion", approval, "parent"), saved);
  assert.throws(() => reservePhase(manifest, "another", { max_reservation: 0.6, models: {} }, "parent"), /envelope exhausted/);
  manifest.extension_phases.growth_north.reserved_usd = 0.8; assert.throws(() => reservePhase(manifest, "motion", approval, "parent"), /envelope exhausted/);
  assert.equal(manifest.phases.motion, saved, "Rejected cap drift cannot replace the original phase receipt");
});
test("failed or uncertain action reservations remain held and changed request bodies cannot replay", () => {
  const manifest = ledger(); reservePhase(manifest, "layout", quote.phases.layout, "quote");
  const body = { id: "fixed-id", prompt: "exact prompt" }, saved = prepareAction(manifest, "layout", "queue", "/api/build", body, .2);
  saved.status = "unknown"; assert.equal(prepareAction(manifest, "layout", "queue", "/api/build", body, .2), saved);
  assert.throws(() => prepareAction(manifest, "layout", "queue", "/api/build", { ...body, prompt: "reroll" }, .2), /changed/);
  assert.throws(() => prepareAction(manifest, "layout", "replacement", "/api/build", { ...body, id: "new-id" }, .2), /exhausted/);
  assert.equal(Object.keys(manifest.actions).length, 1);
});
test("text quote treats the hard token bound separately from non-advertised capabilities", () => {
  assert.deepEqual(checkTextQuote({ enabled: true, model: text.model, reservation: .2 }, text, "Layout"), { model: text.model, reservation: .2 });
  assert.throws(() => checkTextQuote({ enabled: true, model: text.model, reservation: .2 }, { ...text, parameters: { max_tokens: 32768 } }, "Layout"), /ceiling/);
  assert.throws(() => checkTextQuote({ enabled: true, model: "substitution", reservation: .2 }, text, "Layout"), /changed/);
});
test("asset parameters and reservations remain exact, including six-decimal amount bounds", () => {
  const approved = { model: "mesh", reservation: .85, parameters: { enable_pbr: true } };
  assert.deepEqual(checkQuote({ ...approved, enabled: true }, approved, "Mesh"), approved);
  assert.throws(() => checkQuote({ ...approved, enabled: true, parameters: { enable_pbr: false } }, approved, "Mesh"), /changed/);
  assert.throws(() => checkQuote({ ...approved, enabled: false }, approved, "Mesh"), /changed/);
  assert.throws(() => checkQuote({ ...approved, enabled: true, reservation: NaN }, approved, "Mesh"), /reservation/);
});
test("UTF8 context gate includes non-ASCII bytes and rejects before any LLM request", () => {
  checkTextContext({ request: "small", saved_place: {} }); assert.throws(() => checkTextContext({ request: "界".repeat(7000) }), /20KB/);
});
test("review approval is pinned to the exact generated definition before applying", () => {
  const reviewed = { approved: true, definition_sha256: "frozen", reviewed_at: "2026-10-04T10:10:00Z" };
  requireReview(reviewed, "frozen", "Appearance");
  for (const value of [undefined, { ...reviewed, approved: false }, { ...reviewed, definition_sha256: "other" }, { ...reviewed, reviewed_at: "invalid" }]) assert.throws(() => requireReview(value, "frozen", "Appearance"), /exact bytes/);
});
test("layout plan must include both generated mesh roles under the requested material bound", () => {
  const plan = { material_plan: [{ id: "wall" }], mesh_plan: [{ role: "prop", targets: [{ object_id: "chair" }] }, { role: "exterior", targets: [{ object_id: "shell" }] }] };
  const definition = { width: 40, depth: 40, objects: [{ id: "workshop", kind: "building", label: "Copper Workshop", structure: { floors: [{ id: "ground" }, { id: "upper" }] } }, { id: "bakery", kind: "building" }, { id: "books", kind: "building" },
    { id: "chair", kind: "volume", placement: { building_id: "workshop", floor_id: "upper" } }, { id: "shell", kind: "volume" }] };
  assert.deepEqual(validatePlan(plan, definition), { materials: 1, meshes: 2 });
  assert.throws(() => validatePlan({ ...plan, material_plan: Array.from({ length: 4 }, () => ({})) }), /1–3/);
  assert.throws(() => validatePlan({ ...plan, mesh_plan: plan.mesh_plan.slice(0, 1) }), /exactly/);
  const wrongFloor = structuredClone(definition); wrongFloor.objects[3].placement.floor_id = "ground"; assert.throws(() => validatePlan(plan, wrongFloor), /upper floor/);
  const noUpper = structuredClone(definition); noUpper.objects[0].structure.floors.pop(); assert.throws(() => validatePlan(plan, noUpper), /two structured floors/);
});
