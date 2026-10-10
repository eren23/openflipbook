/** Two opt-in real adjoining layouts. Imports and guards never submit work. */
import assert from "node:assert/strict";
import { jsonHash, checkTextContext, checkTextQuote } from "./run-quality-pilot.mjs";
import { buildConnectionInput } from "./quality-pilot-continuation.mjs";

export const GROWTH_AREAS = {
  west: { side: "west", width: 16, depth: 40, label: "Clockmakers Western Lane", buildings: ["Clockmakers Guild", "Workshop Lodge"], max_objects: 7 },
  north: { side: "north", width: 40, depth: 40, label: "Contemporary Civic Garden", buildings: ["Civic Reading Hall"], max_objects: 6 },
};
const micro = value => { assert.ok(Number.isFinite(value) && value >= 0); const n = Math.round(value * 1e6); assert.ok(Math.abs(n / 1e6 - value) < 1e-9); return n; };

export function validateGrowthQuote(receipt, quote, approved = true, now = Date.now()) {
  assert.equal(quote.version, 1); assert.equal(quote.kind, "quality-pilot-growth");
  assert.equal(quote.project, receipt.project); assert.match(quote.session_id, /^session_[A-Za-z0-9_-]+$/);
  assert.equal(quote.evidence_dir, receipt.evidence_dir); assert.equal(quote.parent_quote_sha256, receipt.quote_sha256);
  assert.equal(quote.cap_usd, receipt.cap_usd); assert.equal(quote.cap_usd, 5);
  const parent = Object.values(receipt.quote.phases).reduce((n, phase) => n + micro(phase.max_reservation), 0);
  assert.equal(micro(quote.parent_envelope_usd), parent); assert.equal(micro(quote.max_reservation), 400_000);
  assert.equal(micro(quote.cumulative_envelope_usd), parent + 400_000); assert.ok(parent + 400_000 <= micro(quote.cap_usd), "Original envelopes plus growth exceed cumulative cap");
  assert.equal(quote.asset_generations, 0); assert.equal(quote.max_submissions, 2); assert.deepEqual(quote.areas, GROWTH_AREAS);
  assert.deepEqual(quote.model, receipt.quote.phases.expansion.models.layout); assert.equal(quote.model.reservation, 0.2); assert.deepEqual(quote.model.parameters, { max_tokens: 16384 });
  assert.equal(quote.max_context_bytes, 20_000); assert.equal(quote.max_input_utf8_bytes, 32_768);
  assert.ok(Number.isFinite(Date.parse(quote.verified_at)) && Date.parse(quote.verified_at) <= now + 60_000);
  assert.ok(Date.parse(quote.expires_at) > now && Date.parse(quote.expires_at) <= Date.parse(receipt.quote.expires_at), "Growth approval expired or outlives parent prices");
  assert.ok(typeof quote.authority === "string" && quote.authority);
  if (approved) { assert.equal(quote.approval?.approved, true, "Root must review this separate extension quote"); assert.equal(quote.approval.reviewed_by, "root"); assert.ok(Number.isFinite(Date.parse(quote.approval.reviewed_at))); }
  return quote;
}

export function reserveGrowth(manifest, receipt, quote) {
  validateGrowthQuote(receipt, quote); assert.equal(manifest.world.session_id, quote.session_id); assert.equal(manifest.project, quote.project);
  assert.equal(manifest.cap_usd, quote.cap_usd); assert.equal(manifest.phases.expansion?.status, "complete", "Preserve the reviewed original annex first");
  assert.ok(!manifest.motion_study_id && !manifest.actions["motion:clip"], "Grow before freezing motion references");
  for (const [name, phase] of Object.entries(manifest.phases)) assert.deepEqual(phase.approval, receipt.quote.phases[name], "Original phase approval changed");
  const old = manifest.extensions?.growth;
  if (old) { assert.deepEqual(old.approval, quote, "Growth approval changed after reservation"); return old; }
  assert.ok(!Object.keys(manifest.extension_phases ?? {}).length, "Another extension already owns the remaining envelope");
  manifest.extensions ??= {}; manifest.extension_phases ??= {};
  const state = { version: 1, approval: structuredClone(quote), approval_sha256: jsonHash(quote), parent_quote_sha256: receipt.quote_sha256, status: "reserved", created_at: new Date().toISOString() };
  manifest.extensions.growth = state;
  for (const phase of Object.keys(GROWTH_AREAS)) manifest.extension_phases[`growth_${phase}`] = { reserved_usd: 0.2, max_submissions: 1, status: "reserved" };
  return state;
}

export function prepareGrowthAction(manifest, phase, name, path, body, reservation = 0) {
  assert.ok(Object.hasOwn(GROWTH_AREAS, phase)); const key = `growth-${phase}:${name}`, input_sha256 = jsonHash([path, body]);
  const old = manifest.actions[key];
  if (old) { assert.equal(old.input_sha256, input_sha256, "Frozen growth action changed"); assert.equal(old.reserved_usd, reservation); assert.ok(!["sent", "unknown", "rejected"].includes(old.status), "Unresolved growth action requires explicit reconciliation; no automatic retry"); return old; }
  const prior = Object.values(manifest.actions).filter(a => a.phase === `growth_${phase}`);
  assert.ok(prior.reduce((n, a) => n + micro(a.reserved_usd), 0) + micro(reservation) <= micro(manifest.extension_phases[`growth_${phase}`].reserved_usd), "Growth phase envelope exhausted");
  assert.ok(!reservation || prior.every(a => !a.reserved_usd), "Only one layout submission per adjoining area");
  const action = { phase: `growth_${phase}`, name, path, body: structuredClone(body), input_sha256, reserved_usd: reservation, status: "prepared", created_at: new Date().toISOString() }; manifest.actions[key] = action; return action;
}

export function assertPriorNetwork(before, after, newPlaces = [], newConnections = []) {
  assert.ok(before && after); assert.equal(after.chunks.length, before.chunks.length + newPlaces.length, "Unexpected world area added or removed");
  assert.equal(after.connections.length, before.connections.length + newConnections.length, "Unexpected boundary added or removed");
  for (const chunk of before.chunks) {
    const current = after.chunks.find(c => c.scene.place_id === chunk.scene.place_id); assert.ok(current);
    for (const key of ["x", "z"]) assert.equal(current[key], chunk[key], "Saved area placement changed");
    for (const key of ["id", "place_id", "revision"]) assert.equal(current.scene[key], chunk.scene[key], "Saved scene identity or revision changed");
    assert.deepEqual(current.scene.definition, chunk.scene.definition, "Original objects, furnishings or asset bindings changed");
  }
  for (const link of before.connections) assert.deepEqual(after.connections.find(c => c.id === link.id), link, "Saved boundary changed");
  for (const pid of newPlaces) assert.ok(after.chunks.some(c => c.scene.place_id === pid));
  for (const link of newConnections) assert.deepEqual(after.connections.find(c => c.id === link.id), link);
}

export function validateGrowthLayout(area, job, definition) {
  const wanted = GROWTH_AREAS[area]; assert.ok(wanted); assert.equal(job.status, "ready");
  assert.equal((job.material_plan ?? []).length, 0, "Growth cannot schedule material generation"); assert.equal((job.mesh_plan ?? []).length, 0, "Growth cannot schedule mesh generation");
  assert.equal(definition.width, wanted.width); assert.equal(definition.depth, wanted.depth); assert.equal(definition.label, wanted.label);
  assert.ok(definition.objects.length <= wanted.max_objects); assert.deepEqual(definition.objects.filter(o => o.kind === "building").map(o => o.label).sort(), [...wanted.buildings].sort());
  assert.ok(definition.objects.every(o => !o.asset_id && !o.materials && o.kind !== "mesh"), "Generated layout must contain ordinary components only; no hidden new assets");
}

export function growthProposalReviewed(manifest, phase, proposal) {
  const review = manifest.reviews?.growth?.[phase]; return review?.approved === true && review.proposal_id === proposal.id
    && review.definition_sha256 === jsonHash(proposal.definition) && Number.isFinite(Date.parse(review.reviewed_at));
}

export async function awaitGrowthAcknowledgement(acknowledged, pause, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!acknowledged()) { assert.ok(Date.now() < deadline, "UI acknowledgement remains unresolved; preserve the original request"); await pause(25); }
}

export function assertSavedGrowth(manifest, network) {
  for (const phase of Object.keys(GROWTH_AREAS)) {
    const state = manifest.extension_phases?.[`growth_${phase}`]; if (state?.status !== "complete") continue;
    const saved = network.chunks.find(c => c.scene.place_id === state.boundary.place_id); assert.ok(saved, "Saved growth area missing");
    assert.equal(saved.scene.revision, state.result.revision); assert.equal(jsonHash(saved.scene.definition), state.result.definition_sha256, "Earlier reviewed growth geometry changed");
  }
}

export function finalGrowthMetrics(network) {
  const minX = Math.min(...network.chunks.map(c => c.x)), minZ = Math.min(...network.chunks.map(c => c.z));
  const width = Math.max(...network.chunks.map(c => c.x + c.scene.definition.width)) - minX, depth = Math.max(...network.chunks.map(c => c.z + c.scene.definition.depth)) - minZ;
  const buildings = network.chunks.flatMap(c => c.scene.definition.objects.filter(o => o.kind === "building"));
  assert.equal(width, 80); assert.equal(depth, 80); assert.equal(buildings.length, 8); assert.equal(new Set(buildings.map(b => b.id)).size, 8);
  return { bounding_width: width, bounding_depth: depth, buildings: buildings.length, places: network.chunks.length, occupied_area_m2: network.chunks.reduce((n, c) => n + c.scene.definition.width * c.scene.definition.depth, 0), fully_filled_rectangle: false, separate_style_worlds_verified: false };
}

export async function runGrowthArea({ phase, manifest, quote, page, get, post, persist, ready, screen, save, approvedUiWrites }) {
  const area = GROWTH_AREAS[phase], state = manifest.extension_phases[`growth_${phase}`], extension = manifest.extensions.growth;
  assert.ok(area && state); if (phase === "north") assert.equal(manifest.extension_phases.growth_west.status, "complete", "Review and apply west before generating north");
  const sid = manifest.world.session_id, pid = manifest.world.place_id, base = `/api/world/${sid}/places/${pid}`, connectionsPath = `${base}/connections`;
  const navigate = async placeId => { await page.goto(`/sketch/world?world=${sid}&place=${placeId}&view=orbit`, { waitUntil: "domcontentloaded" }); await ready(); };
  const source = (await get(`${base}/scene`)).scene, network = (await get(connectionsPath)).network;
  if (!extension.baseline) { assert.equal(network.chunks.length, 2); assert.equal(network.chunks.flatMap(c => c.scene.definition.objects.filter(o => o.kind === "building")).length, 5); extension.baseline = structuredClone(network); await persist(); }
  const created = key => manifest.actions[`growth-${key}:generate`]?.status === "acknowledged";
  const completed = Object.keys(GROWTH_AREAS).filter(created).map(key => manifest.extension_phases[`growth_${key}`]);
  assertPriorNetwork(extension.baseline, network, completed.map(p => p.boundary.place_id), completed.map(p => p.boundary.proposal.connection));
  assertSavedGrowth(manifest, network);
  if (state.status === "complete") { if (phase === "north") state.result.metrics = finalGrowthMetrics(network); await save("already-saved-network", network); return; }
  if (!state.source) {
    const config = (await get(`${connectionsPath}?generation=1`)).capabilities; state.quote = checkTextQuote(config, quote.model, "Growth layout");
    assert.equal(source.source_node_id, null, "Growth remains source-free"); state.source = { revision: source.revision, definition: structuredClone(source.definition) };
    state.definition = { version: 2, label: area.label, width: area.width, depth: area.depth, units: "authored_metres", entrance: { x: area.width / 2, z: area.depth - 1.2, yaw: 0 }, objects: [] };
    state.preview_body = { side: area.side, width: 3, source_revision: source.revision, definition: state.definition }; await persist();
  }
  assert.equal(source.revision, state.source.revision); assert.deepEqual(source.definition, state.source.definition);
  await navigate(pid);
  await page.getByText("Add adjoining area", { exact: true }).click();
  await page.getByLabel("Adjoining area name", { exact: true }).fill(area.label); await page.getByRole("button", { name: `Expand ${area.side}`, exact: true }).click();
  await page.getByLabel("Adjoining width", { exact: true }).fill(String(area.width)); await page.getByLabel("Adjoining depth", { exact: true }).fill(String(area.depth)); await page.getByLabel("Connection width", { exact: true }).fill("3");
  approvedUiWrites.set(connectionsPath, async (route, body) => {
    assert.deepEqual(body, state.preview_body); state.boundary = await post("boundary-preview", connectionsPath, state.preview_body); await save("boundary-proposal", state.boundary); await persist(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.boundary) });
  });
  await page.getByRole("button", { name: "Preview adjoining area", exact: true }).click(); await page.getByRole("region", { name: "Connection preview", exact: true }).waitFor({ state: "visible" });
  assert.ok(state.boundary); const link = state.boundary.proposal.connection;
  assert.equal(link.a.place_id, pid); assert.equal(link.a.side, area.side); assert.equal(link.b.place_id, state.boundary.place_id); assert.equal(link.width, 3);
  if (!state.body) {
    const prompt = phase === "west"
      ? "Create only this saved 16 by 40 metre western lane. Add exactly two distinct traditional fantasy single-storey structured buildings named Clockmakers Guild and Workshop Lodge. Give them ordinary usable doors and windows, warm ochre stone facades and contrasting teal/terracotta pitched roofs. Arrange them asymmetrically in the narrow lane with a broad connected pedestrian path."
      : "Create only this saved 40 by 40 metre northern civic garden. Add exactly one distinct contemporary single-storey structured building named Civic Reading Hall: a clean pale-stone rectangular pavilion with simple restrained roof silhouette, large ordinary glazed window openings, and an uncluttered asymmetrical garden forecourt. Use ordinary supported structured architecture, not a generated mesh.";
    state.prompt = `${prompt} Keep the saved dimensions, entrance and complete supplied 3 metre ${link.b.side} boundary opening exactly. Keep a full metre of approach clear and connect the saved entrance, connection and every new doorway with continuous open circulation. Use at most ${area.max_objects} objects. The existing district and Canal Garden Annex are immutable neighboring areas: do not recreate or alter them. Return no materials or meshes requests, no asset bindings, no additional connections, no floor furnishings and no additional generation. Return objects additions in the ordinary architectural schema. Preserve the area's label. One proposal only.`;
    checkTextContext({ request: state.prompt, saved_place: state.definition, connection_input: buildConnectionInput(state.boundary.place_id, { connections: [link] }) });
    state.body = { action: "generate", place_id: state.boundary.place_id, proposal_id: state.boundary.proposal.id, prompt: state.prompt, confirmed: true, model: state.quote.model, reservation: state.quote.reservation }; await persist();
  }
  let generationAcknowledged = false;
  if (!manifest.actions[`growth-${phase}:generate`]) {
    await page.getByRole("checkbox", { name: "Generate layout in new area", exact: true }).check(); await page.getByLabel("Adjoining area description", { exact: true }).fill(state.prompt);
    await page.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only", exact: true }).check(); await screen("quoted-adjoining-area");
    approvedUiWrites.set(connectionsPath, async (route, body) => { assert.deepEqual(body, state.body); const result = await post("generate", connectionsPath, state.body, 0.2); state.job_id = result.job.id; await persist(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) }); generationAcknowledged = true; });
    await page.getByRole("button", { name: "Create and generate", exact: true }).click();
  } else { const result = await post("generate", connectionsPath, state.body, 0.2); state.job_id = result.job.id; await persist(); generationAcknowledged = true; }
  await awaitGrowthAcknowledgement(() => generationAcknowledged, delay => page.waitForTimeout(delay));
  assert.equal(state.job_id, `adjacent_${state.boundary.proposal.id}`); const targetBase = `/api/world/${sid}/places/${state.boundary.place_id}`, buildPath = `${targetBase}/build`;
  const deadline = Date.now() + 5 * 60_000; let job;
  for (;;) { const library = await get(buildPath); await save("saved-layout-library", library); job = library.jobs.find(j => j.id === state.job_id); assert.ok(job); if (job.status === "ready") break; assert.ok(!["invalid", "failed", "cancelled", "submission_unknown", "needs_review"].includes(job.status), "Known layout needs review; never reroll"); assert.ok(Date.now() < deadline, "Layout pending; stop and reconcile, never retry"); await page.waitForTimeout(5000); }
  assert.equal((job.material_plan ?? []).length, 0); assert.equal((job.mesh_plan ?? []).length, 0);
  await navigate(state.boundary.place_id); const panel = page.getByRole("region", { name: "AI place layout", exact: true }); await panel.getByRole("button", { name: "Refresh layout jobs", exact: true }).click();
  approvedUiWrites.set(buildPath, async (route, body) => { assert.deepEqual(body, { action: "preview", id: state.job_id }); const result = await post("layout-preview", buildPath, body); state.proposal = result.proposal; await save("layout-proposal", state.proposal); await persist(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) }); });
  await panel.locator("li").filter({ has: page.getByText(state.prompt, { exact: true }) }).getByRole("button", { name: "Preview generated layout", exact: true }).click();
  await page.getByRole("region", { name: "World change preview", exact: true }).waitFor({ state: "visible" }); validateGrowthLayout(phase, job, state.proposal.definition); await screen("actual-layout-preview");
  const currentNetwork = (await get(connectionsPath)).network, all = Object.values(manifest.extension_phases).filter(p => p.boundary);
  assertPriorNetwork(extension.baseline, currentNetwork, all.map(p => p.boundary.place_id), all.map(p => p.boundary.proposal.connection));
  state.result = { applied: false, place_id: state.boundary.place_id, proposal_id: state.proposal.id, definition_sha256: jsonHash(state.proposal.definition), job_id: state.job_id }; await persist();
  if (!growthProposalReviewed(manifest, phase, state.proposal)) { state.status = "awaiting_review"; await persist(); return; }
  const scenePath = `${targetBase}/scene`;
  approvedUiWrites.set(scenePath, async (route, body) => { assert.deepEqual(body, { action: "apply", proposal_id: state.proposal.id }); const result = await post("apply", scenePath, body); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) }); });
  await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await ready();
  await page.getByRole("region", { name: "World change preview", exact: true }).waitFor({ state: "hidden" });
  const saved = (await get(scenePath)).scene; assert.equal(saved.revision, 2); assert.equal(jsonHash(saved.definition), state.result.definition_sha256); validateGrowthLayout(phase, job, saved.definition); await save("saved-scene", saved);
  const final = (await get(connectionsPath)).network; assertPriorNetwork(extension.baseline, final, all.map(p => p.boundary.place_id), all.map(p => p.boundary.proposal.connection)); assertSavedGrowth(manifest, final);
  state.status = "complete"; state.result.applied = true; state.result.revision = saved.revision; state.completed_at = new Date().toISOString(); if (phase === "north") { state.result.metrics = finalGrowthMetrics(final); extension.status = "complete"; }
  await persist(); await save("saved-network", final); await screen("saved-3d"); await navigate(pid); await screen("original-district-preserved");
}
