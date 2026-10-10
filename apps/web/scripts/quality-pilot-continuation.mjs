/** Bounded continuations through the saved-world product APIs; no provider calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const hashDefinition = definition => createHash("sha256").update(JSON.stringify(definition)).digest("hex");
const phases = new Set(["furnishing", "edit", "expansion"]);
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function requireAppearanceReview(manifest) {
  assert.equal(manifest.phases.capture?.status, "complete", "Apply and capture the complete appearance before continuing");
  const review = manifest.reviews?.appearance;
  assert.equal(review?.approved, true, "Root must review the actual saved appearance before another paid phase");
  assert.equal(review.definition_sha256, manifest.phases.appearance?.result?.definition_sha256, "Appearance review does not match the saved output");
  assert.ok(Number.isFinite(Date.parse(review.reviewed_at)), "Appearance review needs its recorded time");
}
export function proposalApproved(manifest, phase, action, proposal) {
  const review = manifest.reviews?.[phase]?.[action];
  return review?.approved === true && review.proposal_id === proposal.id
    && review.definition_sha256 === hashDefinition(proposal.definition) && Number.isFinite(Date.parse(review.reviewed_at));
}
export function assertUnchangedObjects(before, after, allowed = []) {
  const permitted = new Set(allowed);
  const { objects: oldObjects, ...oldPlace } = before, { objects: newObjects, ...newPlace } = after;
  assert.deepEqual(newPlace, oldPlace, "The authored place dimensions, entrance and identity changed");
  for (const object of oldObjects) {
    const next = newObjects.find(item => item.id === object.id);
    assert.ok(next, `Saved object ${object.label} was removed`);
    assert.equal(next.entity_id, object.entity_id, "Saved world entity identity changed");
    assert.equal(next.label, object.label, "Saved named target changed");
    if (!permitted.has(object.id)) assert.deepEqual(next, object, `Unselected saved object ${object.label} changed`);
  }
}
export function workshop(definition) {
  const object = definition.objects.find(item => item.label === "Copper Workshop" && item.kind === "building");
  assert.ok(object?.structure?.floors.length === 2, "The saved two-storey Copper Workshop is required");
  return object;
}
export function validateFurnishing(before, after, target) {
  assertUnchangedObjects(before, after);
  const ids = new Set(before.objects.map(object => object.id)), additions = after.objects.filter(object => !ids.has(object.id));
  assert.equal(additions.length, 2, "Furnishing must add exactly the two requested components");
  assert.deepEqual(additions.map(object => object.label).sort(), ["Reading bench", "Workshop storage barrels"]);
  for (const object of additions) {
    assert.equal(object.kind, { "Reading bench": "bench", "Workshop storage barrels": "barrels" }[object.label], "Furnishing must use the requested component for each named object");
    assert.deepEqual(object.placement, target, "Furnishing escaped the reviewed upper floor");
    assert.ok(!object.asset_id, "Furnishing cannot generate another mesh");
  }
}
export function validateStructuralEdit(before, after, targetId) {
  assertUnchangedObjects(before, after, [targetId]); assert.equal(after.objects.length, before.objects.length);
  const previous = before.objects.find(object => object.id === targetId), current = after.objects.find(object => object.id === targetId);
  assert.equal(current.x, previous.x + 1, "The requested one-metre eastward move was not applied");
  assert.deepEqual({ ...current, x: previous.x }, previous, "Structural edit changed fields beyond the requested move");
}
export function validateAppearanceEdit(before, after, targetId, scale) {
  assertUnchangedObjects(before, after, [targetId]); assert.equal(after.objects.length, before.objects.length);
  const previous = before.objects.find(object => object.id === targetId), current = after.objects.find(object => object.id === targetId);
  assert.ok(previous.materials?.wall?.asset_id, "Review a generated wall material before its appearance edit");
  assert.deepEqual(current.materials, { ...previous.materials, wall: { ...previous.materials.wall, tile_metres: scale } }, "Appearance edit must reuse the saved wall tile and change only its scale");
  assert.deepEqual({ ...current, materials: previous.materials }, previous, "Appearance edit changed geometry or identity");
}
export function buildConnectionInput(placeId, network) {
  const connections = (network?.connections ?? []).filter(link => link.a.place_id === placeId || link.b.place_id === placeId)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(link => ({ id: link.id, version: link.version, kind: link.kind, a: { place_id: link.a.place_id, side: link.a.side, offset: link.a.offset },
      b: { place_id: link.b.place_id, side: link.b.side, offset: link.b.offset }, width: link.width, created_at: link.created_at }));
  return { version: 1, place_id: placeId, connections };
}

export async function runContinuationPhase(context) {
  const { phase, manifest, phaseState, get, post, id, persist, navigate, readScene, snapshot, captureScreen, page, button,
    checkQuote, checkTextContext, waitForJob, approvedUiWrites, log, atomicJson, directory } = context;
  assert.ok(phases.has(phase), "Unknown continuation phase"); requireAppearanceReview(manifest);
  const sid = manifest.world.session_id, pid = manifest.world.place_id; assert.ok(safeId(sid) && safeId(pid));
  const base = `/api/world/${sid}/places/${pid}`, scenePath = `${base}/scene`, buildPath = `${base}/build`, editPath = `${base}/text-edits`, connectionsPath = `${base}/connections`;
  phaseState.steps ??= {}; phaseState.awaiting_review = false; await persist();
  const save = async (name, value) => atomicJson(join(directory, `${phase}-${name}.json`), value);
  const connections = async placeId => buildConnectionInput(placeId, (await get(`/api/world/${sid}/places/${placeId}/connections`)).network);
  const currentMaterials = async () => (await get(`/api/world/${sid}/materials`)).assets.map(asset => ({ id: asset.id, sha256: asset.sha256, prompt: asset.prompt.slice(0, 300) }));
  const pending = async (name, step) => {
    phaseState.awaiting_review = true; phaseState.result = { action: name, proposal_id: step.proposal.id, definition_sha256: hashDefinition(step.proposal.definition), applied: false };
    await persist(); await log("continuation_ready_for_review", { action: name, ...phaseState.result }); return { awaiting_review: true };
  };
  const showPreview = async (name, path, body, prompt, panelName, previewLabel, placeId = pid) => {
    if (placeId === pid) await navigate("orbit");
    else await page.goto(`/sketch/world?world=${sid}&place=${placeId}&view=orbit`, { waitUntil: "domcontentloaded" });
    const panel = page.getByRole("region", { name: panelName, exact: true });
    await panel.getByRole("button", { name: panelName === "Text scene edits" ? "Refresh scene edit jobs" : "Refresh layout jobs", exact: true }).click();
    let proposal;
    approvedUiWrites.set(path, async (route, sent) => {
      assert.deepEqual(sent, body, "Preview must use the same saved job");
      const response = await post(`${name}-preview`, path, body); proposal = response.proposal;
      await save(`${name}-proposal`, proposal); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
    });
    const row = panel.locator("li").filter({ has: page.getByText(prompt, { exact: true }) });
    await row.getByRole("button", { name: previewLabel, exact: true }).click();
    await page.getByRole("region", { name: "World change preview", exact: true }).waitFor({ state: "visible" });
    assert.ok(proposal, "The actual UI preview acknowledgement is required");
    await captureScreen(`${name}-preview`); return proposal;
  };
  const apply = async (name, step, validate, destination = scenePath) => {
    const current = await readScene();
    assert.equal(current.revision, step.base_revision, "Saved geometry changed after the reviewed proposal");
    assert.equal(hashDefinition(current.definition), hashDefinition(step.before), "Proposal input changed after review");
    validate(step.before, step.proposal.definition);
    if (!proposalApproved(manifest, phase, name, step.proposal)) return pending(name, step);
    await post(`${name}-apply`, destination, { action: "apply", proposal_id: step.proposal.id });
    const saved = await snapshot(`${name}-applied`); assert.equal(saved.revision, step.base_revision + 1);
    assert.equal(hashDefinition(saved.definition), hashDefinition(step.proposal.definition), "Applied scene differs from the reviewed proposal");
    validate(step.before, saved.definition); step.status = "applied"; step.applied_revision = saved.revision; await persist();
    await navigate("orbit"); await button("Copper Workshop building").click(); await button("Frame selected in 3D").click(); await captureScreen(`${name}-saved`);
    return { applied: true };
  };

  if (phase === "furnishing") {
    const name = "upper-floor", scene = await readScene(), building = workshop(scene.definition);
    let step = phaseState.steps[name];
    if (!step) {
      const target = { building_id: building.id, floor_id: building.structure.floors[1].id };
      const prompt = `Furnish only Copper Workshop's saved upper floor (${target.floor_id}) with exactly two ordinary saved components: one small bench labelled Reading bench and one compact barrels component labelled Workshop storage barrels. Keep all saved geometry, doors, rooms, stairs, textures, generated meshes and existing furnishings unchanged. Use the exact target_floor placement IDs. Put both additions against clear interior walls, separated from the existing carved chair and all stair/door approaches. Preserve reachable room circulation. Return no material requests, mesh requests, outdoor additions or extra generation requests.`;
      const library = await get(buildPath), quote = checkQuote(library.capabilities, phaseState.approval.models.layout, "Furnishing");
      assert.equal(library.capabilities.floor_target_version, 1, "Updated furnishing transport is required");
      checkTextContext({ request: prompt, saved_place: scene.definition, target_floor: target, connection_input: await connections(pid) });
      step = { status: "prepared", before: structuredClone(scene.definition), base_revision: scene.revision, target, body: { action: "queue", id: await id("furnishing-upper-floor"), prompt, confirmed: true, ...quote, base_revision: scene.revision, target_floor: target, use_source_image: false } };
      phaseState.steps[name] = step; await persist();
    }
    if (step.status !== "applied") {
      await post(`${name}-queue`, buildPath, step.body, step.body.reservation);
      await post(`${name}-run`, buildPath, { action: "run", id: step.body.id });
      const finished = await waitForJob(buildPath, step.body.id); assert.equal((finished.job.material_plan ?? []).length, 0); assert.equal((finished.job.mesh_plan ?? []).length, 0);
      step.proposal = await showPreview(name, buildPath, { action: "preview", id: step.body.id }, step.body.prompt, "AI place layout", "Preview generated layout");
      validateFurnishing(step.before, step.proposal.definition, step.target); await persist();
      const result = await apply(name, step, (before, after) => validateFurnishing(before, after, step.target)); if (result.awaiting_review) return result;
    }
    phaseState.result = { applied: true, target: step.target, revision: step.applied_revision, proposal_id: step.proposal.id, definition_sha256: hashDefinition(step.proposal.definition) };
  } else if (phase === "edit") {
    for (const name of ["structural", "appearance"]) {
      let step = phaseState.steps[name];
      if (!step) {
        const scene = await readScene(), selected = workshop(scene.definition), scale = selected.materials?.wall?.tile_metres === 1.5 ? 2.5 : 1.5;
        const prompt = name === "structural"
          ? `Move only the saved Copper Workshop building exactly 1 authored metre east (increase its x by 1), without changing z, heading, dimensions, height, roof, floors, rooms, openings, stairs, labels, entity IDs or generated material bindings. Preserve its floor-bound furnishings in their saved local coordinates and keep every other saved object exactly unchanged. Do not add or remove anything. Return one typed move edit targeting the selected saved building ID, dx:1,dz:0.`
          : `Change only Copper Workshop's saved generated wall material tile_metres to ${scale}. Reuse the exact current wall asset_id ${selected.materials?.wall?.asset_id}; preserve its rotation and roughness and every other material binding. Keep all geometry, color, labels, IDs, doors, windows, floors, rooms, stairs, meshes and other objects exactly unchanged. Return one typed patch of the selected building materials, with every existing binding retained and only wall.tile_metres changed. Do not generate a new texture, add or remove objects, or move anything.`;
        if (name === "appearance") assert.ok(selected.materials?.wall?.asset_id, "Generated workshop wall binding is required for this appearance study");
        const library = await get(editPath), quote = checkQuote(library.capabilities, phaseState.approval.models.edit, "Text edit");
        assert.equal(library.capabilities.contract_version, 1, "Updated typed text edit contract is required");
        checkTextContext({ request: prompt, saved_place: scene.definition, selected_object_ids: [selected.id], connection_input: await connections(pid), materials: await currentMaterials() });
        step = { status: "prepared", before: structuredClone(scene.definition), base_revision: scene.revision, target_id: selected.id, scale,
          body: { action: "plan", id: await id(`edit-${name}`), prompt, confirmed: true, ...quote, base_revision: scene.revision, selected_object_ids: [selected.id] } };
        phaseState.steps[name] = step; await persist();
      }
      if (step.status === "applied") continue;
      await post(`${name}-plan`, editPath, step.body, step.body.reservation); await waitForJob(editPath, step.body.id);
      step.proposal = await showPreview(name, editPath, { action: "preview", id: step.body.id }, step.body.prompt, "Text scene edits", "Preview saved edit");
      const validate = name === "structural" ? (before, after) => validateStructuralEdit(before, after, step.target_id) : (before, after) => validateAppearanceEdit(before, after, step.target_id, step.scale);
      validate(step.before, step.proposal.definition); await persist(); const result = await apply(name, step, validate); if (result.awaiting_review) return result;
    }
    phaseState.result = { applied: true, actions: Object.entries(phaseState.steps).map(([action, step]) => ({ action, proposal_id: step.proposal.id, revision: step.applied_revision, definition_sha256: hashDefinition(step.proposal.definition) })) };
  } else {
    const name = "annex"; let step = phaseState.steps[name];
    if (!step) {
      const scene = await readScene(), network = (await get(connectionsPath)).network;
      const definition = { version: 2, label: "Canal Garden Annex", width: 24, depth: 32, units: "authored_metres", entrance: { x: 12, z: 30.8, yaw: 0 }, objects: [] };
      const capabilities = (await get(`${connectionsPath}?generation=1`)).capabilities, quote = checkQuote(capabilities, phaseState.approval.models.layout, "Adjoining layout");
      step = { status: "prepared", before: structuredClone(scene.definition), base_revision: scene.revision, original_connections: network?.connections ?? [], quote,
        preview_body: { side: "east", width: 3, source_revision: scene.revision, definition } };
      phaseState.steps[name] = step; await persist();
    }
    if (!step.boundary) { step.boundary = await post(`${name}-boundary-preview`, connectionsPath, step.preview_body); await save(`${name}-boundary-proposal`, step.boundary); await persist(); }
    assert.ok(safeId(step.boundary.place_id) && safeId(step.boundary.proposal.id));
    const annexId = step.boundary.place_id, annexBase = `/api/world/${sid}/places/${annexId}`, annexBuild = `${annexBase}/build`;
    if (!step.body) {
      const boundary = step.boundary.proposal.connection;
      assert.equal(boundary.a.place_id, pid); assert.equal(boundary.a.side, "east"); assert.equal(boundary.b.place_id, annexId); assert.equal(boundary.b.side, "west"); assert.equal(boundary.width, 3);
      const prompt = `Create only the saved Canal Garden Annex, a 24 by 32 metre connected area east of Copper Workshop's district. Preserve the supplied immutable boundary connection exactly. Keep its full 3 metre west opening and one metre clear approach reachable from the saved entrance. Add exactly two small single-storey structured buildings named Canal Tea House and Tool Store, with valid ordinary doors/windows/floors and paths connecting the west boundary, entrance and both doors. Keep wide open circulation and an asymmetric small public garden between them. Use at most six objects. No material requests, mesh requests, new connections, neighboring objects or extra generation. Keep all footprints and roof envelopes within the authored area.`;
      const connection_input = buildConnectionInput(annexId, { connections: [boundary] });
      checkTextContext({ request: prompt, saved_place: step.boundary.proposal.definition, connection_input });
      step.body = { action: "generate", place_id: annexId, proposal_id: step.boundary.proposal.id, prompt, confirmed: true, ...step.quote, use_source_image: false }; await persist();
    }
    if (step.status !== "applied") {
      const source = await readScene(); assert.equal(source.revision, step.base_revision); assert.deepEqual(source.definition, step.before, "Expansion cannot change the source district");
      const queued = await post(`${name}-generate`, connectionsPath, step.body, step.body.reservation); step.job_id = queued.job.id;
      await waitForJob(annexBuild, step.job_id); const library = await get(annexBuild), job = library.jobs.find(item => item.id === step.job_id);
      assert.equal((job.material_plan ?? []).length, 0); assert.equal((job.mesh_plan ?? []).length, 0);
      step.proposal = await showPreview(name, annexBuild, { action: "preview", id: step.job_id }, step.body.prompt, "AI place layout", "Preview generated layout", annexId);
      await save(`${name}-proposal`, step.proposal); assert.equal(step.proposal.definition.width, 24); assert.equal(step.proposal.definition.depth, 32); assert.ok(step.proposal.definition.objects.length <= 6);
      assert.deepEqual(step.proposal.definition.objects.filter(object => object.kind === "building").map(object => object.label).sort(), ["Canal Tea House", "Tool Store"]);
      const afterNetwork = (await get(connectionsPath)).network; assert.ok(afterNetwork);
      for (const link of step.original_connections) assert.deepEqual(afterNetwork.connections.find(current => current.id === link.id), link);
      assert.deepEqual(afterNetwork.connections.find(link => link.id === step.boundary.proposal.connection.id), step.boundary.proposal.connection);
      assert.deepEqual((await readScene()).definition, step.before, "Expansion changed original named targets"); await persist();
      if (!proposalApproved(manifest, phase, name, step.proposal)) return pending(name, step);
      await post(`${name}-apply`, `${annexBase}/scene`, { action: "apply", proposal_id: step.proposal.id });
      const saved = (await get(`${annexBase}/scene`)).scene; assert.equal(hashDefinition(saved.definition), hashDefinition(step.proposal.definition)); assert.equal(saved.revision, 2);
      assert.deepEqual((await readScene()).definition, step.before, "Applying the adjoining place changed the source district");
      step.status = "applied"; step.applied_revision = saved.revision; manifest.expansion = { place_id: annexId, connection_id: step.boundary.proposal.connection.id };
      await save(`${name}-saved-scene`, saved); await persist(); await snapshot("original-after-expansion");
      await page.goto(`/sketch/world?world=${sid}&place=${annexId}&view=orbit`, { waitUntil: "domcontentloaded" }); await captureScreen("annex-saved"); await navigate("orbit");
    }
    phaseState.result = { applied: true, place_id: annexId, connection_id: step.boundary.proposal.connection.id, proposal_id: step.proposal.id, definition_sha256: hashDefinition(step.proposal.definition) };
  }
  phaseState.awaiting_review = false; await persist(); return { awaiting_review: false };
}
