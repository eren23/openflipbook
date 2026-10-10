import assert from "node:assert/strict";
import test from "node:test";
import { GROWTH_AREAS, validateGrowthQuote, reserveGrowth, prepareGrowthAction, assertPriorNetwork, assertSavedGrowth, validateGrowthLayout, growthProposalReviewed, finalGrowthMetrics, awaitGrowthAcknowledgement } from "./quality-pilot-growth.mjs";
import { jsonHash } from "./run-quality-pilot.mjs";

const model = { model: "google/gemini-3.7-flash", reservation: 0.2, parameters: { max_tokens: 16384 } };
function fixture() {
  const now = Date.now(), parent = { phases: { expansion: { max_reservation: 0.2, models: { layout: model } }, remaining: { max_reservation: 3.84, models: {} } }, expires_at: new Date(now + 60_000).toISOString() };
  const receipt = { project: "ofb-pilot-111111111111", cap_usd: 5, evidence_dir: "/private/pilot", quote: parent, quote_sha256: jsonHash(parent) };
  const quote = { version: 1, kind: "quality-pilot-growth", project: receipt.project, session_id: "session_saved", evidence_dir: receipt.evidence_dir, parent_quote_sha256: receipt.quote_sha256, cap_usd: 5, parent_envelope_usd: 4.04, max_reservation: 0.4, cumulative_envelope_usd: 4.44, asset_generations: 0, max_submissions: 2, areas: structuredClone(GROWTH_AREAS), model: structuredClone(model), max_context_bytes: 20_000, max_input_utf8_bytes: 32_768, authority: "Explicit bounded root extension", verified_at: new Date(now).toISOString(), expires_at: parent.expires_at, approval: { approved: true, reviewed_by: "root", reviewed_at: new Date(now).toISOString() } };
  const manifest = { project: receipt.project, cap_usd: 5, world: { session_id: quote.session_id, place_id: "place_saved" }, phases: { expansion: { status: "complete", approval: structuredClone(parent.phases.expansion) } }, actions: { "layout:queue": { body: { id: "original" }, reserved_usd: 0.2, status: "acknowledged" } } };
  return { receipt, quote, manifest };
}
function scene(pid, width, depth, buildings = []) { return { id: `${pid}_scene`, place_id: pid, revision: 2, definition: { label: pid, width, depth, objects: buildings.map((label, i) => ({ id: `${pid}_${i}`, entity_id: `${pid}_entity_${i}`, kind: "building", label })) } }; }
const network = () => ({ chunks: [{ x: 0, z: 0, scene: scene("original", 40, 40, ["A", "B", "C"]) }, { x: 40, z: 4, scene: scene("annex", 24, 32, ["D", "E"]) }], connections: [{ id: "original_link", a: { place_id: "original", side: "east" }, b: { place_id: "annex", side: "west" }, width: 3 }] });

test("growth approval holds every original envelope and needs explicit separate approval", () => {
  const { receipt, quote } = fixture(); assert.equal(validateGrowthQuote(receipt, quote).cumulative_envelope_usd, 4.44);
  const draft = structuredClone(quote); draft.approval.approved = false; assert.throws(() => validateGrowthQuote(receipt, draft), /Root must review/); assert.equal(validateGrowthQuote(receipt, draft, false), draft);
  const changed = structuredClone(receipt); changed.quote.phases.remaining.max_reservation = 4.7; assert.throws(() => validateGrowthQuote(changed, quote));
});
test("quote refuses model, token, geometry, parent hash and expiration drift", () => {
  const { receipt, quote } = fixture();
  for (const alter of [q => { q.model.reservation = 0.1; }, q => { q.model.parameters.max_tokens = 32768; }, q => { q.areas.west.width = 20; }, q => { q.parent_quote_sha256 = "changed"; }, q => { q.expires_at = new Date(Date.now() - 1).toISOString(); }]) { const changed = structuredClone(quote); alter(changed); assert.throws(() => validateGrowthQuote(receipt, changed)); }
});
test("both growth reservations preserve original actions and cannot create a second envelope", () => {
  const { receipt, quote, manifest } = fixture(), old = structuredClone(manifest); reserveGrowth(manifest, receipt, quote); assert.deepEqual(manifest.actions, old.actions); assert.deepEqual(manifest.phases, old.phases); assert.equal(Object.values(manifest.extension_phases).reduce((n, p) => n + p.reserved_usd, 0), 0.4); assert.equal(reserveGrowth(manifest, receipt, quote), manifest.extensions.growth);
  const changed = structuredClone(quote); changed.authority += " changed"; assert.throws(() => reserveGrowth(manifest, receipt, changed), /approval changed/);
});
test("one paid action per area, frozen payload and unknown acknowledgement stop retries", () => {
  const { receipt, quote, manifest } = fixture(); reserveGrowth(manifest, receipt, quote);
  const action = prepareGrowthAction(manifest, "west", "generate", "/api/world/saved/places/place/connections", { id: "fixed", prompt: "saved" }, 0.2); action.status = "acknowledged";
  assert.equal(prepareGrowthAction(manifest, "west", "generate", "/api/world/saved/places/place/connections", { id: "fixed", prompt: "saved" }, 0.2), action);
  assert.throws(() => prepareGrowthAction(manifest, "west", "another", "/path", {}, 0.2), /envelope exhausted/);
  assert.throws(() => prepareGrowthAction(manifest, "west", "generate", "/api/world/saved/places/place/connections", { id: "fixed", prompt: "changed" }, 0.2), /Frozen/);
  action.status = "unknown"; assert.throws(() => prepareGrowthAction(manifest, "west", "generate", "/api/world/saved/places/place/connections", { id: "fixed", prompt: "saved" }, 0.2), /no automatic retry/);
});
test("existing geometry, placement and boundary checks reject unrelated changes", () => {
  const before = network(), link = { id: "west_link" }, after = structuredClone(before); after.chunks.push({ x: -16, z: 0, scene: scene("west", 16, 40) }); after.connections.push(link); assertPriorNetwork(before, after, ["west"], [link]);
  const moved = structuredClone(after); moved.chunks[0].scene.definition.objects[0].label = "changed"; assert.throws(() => assertPriorNetwork(before, moved, ["west"], [link]), /Original objects/);
  const resized = structuredClone(after); resized.chunks[0].x = 1; assert.throws(() => assertPriorNetwork(before, resized, ["west"], [link]), /placement changed/);
  const changedLink = structuredClone(after); changedLink.connections[0].width = 4; assert.throws(() => assertPriorNetwork(before, changedLink, ["west"], [link]), /boundary changed/);
});
test("layout requires exact actual generated names and zero additional asset plans", () => {
  const definition = { ...scene("west", 16, 40, GROWTH_AREAS.west.buildings).definition, label: GROWTH_AREAS.west.label }, job = { status: "ready" }; validateGrowthLayout("west", job, definition);
  assert.throws(() => validateGrowthLayout("west", { ...job, material_plan: [{}] }, definition), /material generation/);
  assert.throws(() => validateGrowthLayout("west", { ...job, mesh_plan: [{}] }, definition), /mesh generation/);
  const incomplete = structuredClone(definition); incomplete.objects.pop(); assert.throws(() => validateGrowthLayout("west", job, incomplete));
});
test("actual root review is bound to proposal ID and exact output bytes", () => {
  const proposal = { id: "reviewed", definition: { objects: [] } }, manifest = { reviews: { growth: { west: { approved: true, proposal_id: "reviewed", definition_sha256: jsonHash(proposal.definition), reviewed_at: new Date().toISOString() } } } };
  assert.equal(growthProposalReviewed(manifest, "west", proposal), true); assert.equal(growthProposalReviewed(manifest, "west", { ...proposal, id: "other" }), false); assert.equal(growthProposalReviewed(manifest, "west", { ...proposal, definition: { objects: [{}] } }), false);
});
test("saved western generation must remain exact during northern addition", () => {
  const current = network(), saved = current.chunks[0].scene, manifest = { extension_phases: { growth_west: { status: "complete", boundary: { place_id: saved.place_id }, result: { revision: saved.revision, definition_sha256: jsonHash(saved.definition) } } } }; assertSavedGrowth(manifest, current); current.chunks[0].scene.definition.objects[0].label = "changed"; assert.throws(() => assertSavedGrowth(manifest, current), /Earlier reviewed/);
});
test("eight building proof measures occupied area separately from bounding rectangle", () => {
  const current = network(); current.chunks.push({ x: -16, z: 0, scene: scene("west", 16, 40, ["F", "G"]) }, { x: 0, z: -40, scene: scene("north", 40, 40, ["H"]) }); const result = finalGrowthMetrics(current); assert.equal(result.buildings, 8); assert.equal(result.bounding_width, 80); assert.equal(result.bounding_depth, 80); assert.equal(result.occupied_area_m2, 4608); assert.equal(result.fully_filled_rectangle, false); assert.equal(result.separate_style_worlds_verified, false);
});

test("a UI click returning before its async acknowledgement cannot advance before persistence and fulfillment", async () => {
  const state = {}, pause = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))); let fulfilled = false;
  const callback = (async () => { await pause(2); state.job_id = "original-fixed-job"; await pause(2); state.persisted = true; await pause(2); fulfilled = true; })();
  assert.equal(state.job_id, undefined); await awaitGrowthAcknowledgement(() => fulfilled, pause, 1000); assert.equal(state.job_id, "original-fixed-job"); assert.equal(state.persisted, true); await callback;
  await assert.rejects(awaitGrowthAcknowledgement(() => false, pause, 1), /remains unresolved/);
});
