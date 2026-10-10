/** Free connected-place acceptance from actual keyboard/pointer input and Rapier.
 * No pose setters, route handoffs, generation calls, or pilot-manifest changes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect as baseExpect } from "@playwright/test";
import { matchPilotWalkObservation, parsePilotWalkObservation, pilotWalkPulse, validatePilotWalkAutosave } from "./quality-pilot-walk.mjs";
import { pilotReviewHash, validatePilotReviewEnvironment } from "./quality-pilot-review-floor.mjs";

const expect = baseExpect.configure({ timeout: 60_000 });
const finite = value => typeof value === "number" && Number.isFinite(value);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const keys = ["w", "a", "s", "d"];

export function normalizedPilotChunks(network, sessionId) {
  assert.ok(Array.isArray(network?.chunks) && network.chunks.length >= 2 && network.chunks.length <= 16, "A saved connected network is required");
  const ids = new Set();
  for (const chunk of network.chunks) {
    assert.ok([chunk.x, chunk.z, chunk.scene?.definition?.width, chunk.scene?.definition?.depth].every(finite));
    assert.ok(safeId(chunk.scene.place_id) && Number.isSafeInteger(chunk.scene.revision) && chunk.scene.revision >= 1);
    if (sessionId !== undefined) assert.equal(chunk.scene.session_id, sessionId, "Connected chunk belongs to another world session");
    assert.ok(!ids.has(chunk.scene.place_id), "Duplicate saved network place"); ids.add(chunk.scene.place_id);
    assert.equal(chunk.scene.definition.version, 2); assert.ok(Array.isArray(chunk.scene.definition.objects));
  }
  const minX = Math.min(...network.chunks.map(chunk => chunk.x)), minZ = Math.min(...network.chunks.map(chunk => chunk.z));
  return network.chunks.map(chunk => ({ ...chunk, x: chunk.x - minX, z: chunk.z - minZ }));
}

const intersects = (a, b, box) => Math.max(a.x, b.x) > box.x1 && Math.min(a.x, b.x) < box.x2
  && Math.max(a.z, b.z) > box.z1 && Math.min(a.z, b.z) < box.z2;
const envelope = (object, chunk) => {
  const c = Math.abs(Math.cos(object.heading)), s = Math.abs(Math.sin(object.heading));
  const w = (object.width * c + object.depth * s) / 2 + 0.35, d = (object.width * s + object.depth * c) / 2 + 0.35;
  return { x1: chunk.x + object.x - w, x2: chunk.x + object.x + w, z1: chunk.z + object.z - d, z2: chunk.z + object.z + d };
};

/** Conservative support for the actual pilot's east connection and one south
 * doorway. Changed geometry that blocks this route is reported, never bypassed.
 */
export function derivePilotConnectedWalkPlan(network, rootId) {
  try {
    const chunks = normalizedPilotChunks(network), root = chunks.find(chunk => chunk.scene.place_id === rootId);
    assert.ok(root, "Saved root chunk is missing");
    const links = (network.connections ?? []).flatMap(connection => {
      const source = [connection.a, connection.b].find(end => end?.place_id === rootId && end.side === "east");
      const destination = [connection.a, connection.b].find(end => end?.place_id !== rootId && end.side === "west");
      return source && destination ? [{ connection, source, destination }] : [];
    });
    assert.equal(links.length, 1, "Exactly one saved east/west root connection is supported");
    const { connection, source, destination } = links[0], annex = chunks.find(chunk => chunk.scene.place_id === destination.place_id);
    assert.ok(annex && connection.kind === "boundary" && connection.version === 1 && finite(connection.width) && connection.width >= 1.2);
    assert.ok([source.offset, destination.offset].every(finite));
    const portal = { x: root.x + root.scene.definition.width, z: root.z + source.offset };
    assert.ok(distance(portal, { x: annex.x, z: annex.z + destination.offset }) <= 0.001, "Saved connection endpoints do not align");
    assert.ok(source.offset - connection.width / 2 >= 0.5 && source.offset + connection.width / 2 <= root.scene.definition.depth - 0.5
      && destination.offset - connection.width / 2 >= 0.5 && destination.offset + connection.width / 2 <= annex.scene.definition.depth - 0.5, "Saved opening lacks capsule clearance");
    const houses = annex.scene.definition.objects.filter(object => object.kind === "building" && object.label === "Canal Tea House");
    assert.equal(houses.length, 1, "Exactly one saved Canal Tea House is required");
    const house = houses[0], structure = house.structure, door = structure?.door, floor = structure?.floors?.[0];
    assert.ok([house.x, house.z, house.width, house.depth, house.height, house.heading, structure?.wall_thickness].every(finite)
      && Math.abs(house.heading) < 1e-8 && !structure.footprint && structure.floors.length === 1 && safeId(floor.id), "Only the saved rectangular heading-zero single-floor tea house is supported");
    assert.ok(door?.side === "south" && !door.wall_id && door.floor === 0 && door.sill === 0 && door.width >= 1.1
      && finite(door.offset) && Math.abs(door.offset) + 0.4 < house.width / 2 - structure.wall_thickness, "Saved south doorway lacks capsule clearance");
    assert.ok(!floor.layout || floor.layout.type === "room", "Only an undivided tea lounge is supported");
    const entrance = root.scene.definition.entrance;
    assert.ok(entrance && [entrance.x, entrance.z, entrance.yaw].every(finite));
    const doorX = annex.x + house.x + door.offset, doorZ = annex.z + house.z + house.depth / 2;
    const points = [
      { label: "root-entrance", x: root.x + entrance.x, z: root.z + entrance.z, place_id: rootId },
      { label: "root-east-corridor", x: portal.x - 4, z: root.z + entrance.z, place_id: rootId },
      { label: "root-portal-approach", x: portal.x - 4, z: portal.z, place_id: rootId },
      { label: "annex-handoff", x: portal.x + 1, z: portal.z, place_id: annex.scene.place_id },
      { label: "annex-door-lane", x: doorX, z: portal.z, place_id: annex.scene.place_id },
      { label: "tea-house-outside", x: doorX, z: doorZ + 1, place_id: annex.scene.place_id },
      { label: "tea-lounge-inside", x: doorX, z: doorZ - 1.5, place_id: annex.scene.place_id },
    ];
    assert.ok(portal.z > doorZ + 1.2 && doorX > annex.x + 1.5, "The saved tea house must be north/east of the approach lane");
    const inside = points.at(-1);
    assert.ok(inside.z > annex.z + house.z - house.depth / 2 + structure.wall_thickness + 0.35, "Saved doorway route reaches too close to the north wall");
    for (const point of points) {
      const chunk = chunks.find(item => item.scene.place_id === point.place_id);
      assert.ok(point.x >= chunk.x + 0.35 && point.x <= chunk.x + chunk.scene.definition.width - 0.35
        && point.z >= chunk.z + 0.35 && point.z <= chunk.z + chunk.scene.definition.depth - 0.35, `${point.label} lies outside the saved chunk`);
    }
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      assert.ok(Math.abs(a.x - b.x) < 1e-8 || Math.abs(a.z - b.z) < 1e-8, "Only measured axis-aligned segments are supported");
      for (const chunk of chunks) for (const object of chunk.scene.definition.objects) {
        if (object.kind === "path") continue;
        if (object.placement) {
          if (index !== points.length - 1 || object.placement.building_id !== house.id || object.placement.floor_id !== floor.id) continue;
          const placed = { ...object, x: house.x + object.x, z: house.z + object.z };
          assert.ok(!intersects(a, b, envelope(placed, annex)), `Saved interior object ${object.label} blocks the tea lounge doorway`);
          continue;
        }
        // Only the final, door-aligned segment crosses the target shell.
        if (index === points.length - 1 && chunk === annex && object.id === house.id) continue;
        assert.ok([object.x, object.z, object.width, object.depth, object.heading].every(finite));
        assert.ok(!intersects(a, b, envelope(object, chunk)), `Saved ${object.label} blocks ${b.label}`);
      }
    }
    return { supported: true, chunks, root_id: rootId, annex_id: annex.scene.place_id, connection_id: connection.id,
      connection, portal, points, building_id: house.id, building_label: house.label,
      floor_id: floor.id, floor_label: floor.label, ...(floor.layout ? { room_id: floor.layout.id } : {}), expected_eye_y: 1.6 };
  } catch (error) { return { supported: false, reason: error.message }; }
}

export function pilotConnectedSpace(definition, position) {
  for (const building of definition.objects) {
    const structure = building.structure;
    if (building.kind !== "building" || !structure || position.y >= building.height - structure.roof_height) continue;
    const dx = position.x - building.x, dz = position.z - building.z, c = Math.cos(building.heading), s = Math.sin(building.heading);
    const point = { x: dx * c + dz * s, z: -dx * s + dz * c };
    if (Math.abs(point.x) >= building.width / 2 || Math.abs(point.z) >= building.depth / 2) continue;
    assert.ok(!structure.footprint, "Unrecognized nonrectangular interior encountered by actual walker");
    const storey = (building.height - structure.roof_height) / structure.floors.length;
    const floor = structure.floors[Math.max(0, Math.floor((position.y - 0.8 + 0.05) / storey))]; if (!floor) continue;
    const thickness = structure.wall_thickness;
    const roomAt = (node, bounds) => {
      if (!node || point.x <= bounds.x1 || point.x >= bounds.x2 || point.z <= bounds.z1 || point.z >= bounds.z2) return null;
      if (node.type === "room") return node.id;
      assert.equal(node.type, "split");
      const a = { ...bounds }, b = { ...bounds };
      if (node.axis === "x") { a.x2 = node.position - thickness / 2; b.x1 = node.position + thickness / 2; }
      else { assert.equal(node.axis, "z"); a.z2 = node.position - thickness / 2; b.z1 = node.position + thickness / 2; }
      return roomAt(node.a, a) ?? roomAt(node.b, b);
    };
    const room = roomAt(floor.layout, { x1: -building.width / 2 + thickness, x2: building.width / 2 - thickness,
      z1: -building.depth / 2 + thickness, z2: building.depth / 2 - thickness });
    return { building_id: building.id, floor_id: floor.id, ...(room ? { room_id: room } : {}) };
  }
  return null;
}

/** Body stays place-local; measured camera history stays network-global. */
export function validatePilotConnectedAutosave(body, chunks, observations) {
  const chunk = chunks.find(item => item.scene.place_id === body?.pose?.place_id);
  assert.ok(chunk, "Autosave does not belong to an owned connected place");
  const local = observations.filter(sample => sample.place_id === chunk.scene.place_id)
    .map(sample => ({ ...sample, x: sample.x - chunk.x, z: sample.z - chunk.z }));
  const pose = validatePilotWalkAutosave(body, { place_id: chunk.scene.place_id }, chunk.scene, local);
  assert.deepEqual(pose.space, pilotConnectedSpace(chunk.scene.definition, pose.position), "Actual saved building/floor/room differs from authoritative local geometry");
  return { pose, chunk, matched_local_camera: matchPilotWalkObservation(pose, local) };
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file); await chmod(file, 0o600);
}

export async function verifyPilotConnectedWalk({ page, manifest, directory, approvedUiWrites, get, navigate, readNetwork, log = async () => {}, saveJson = atomicJson }) {
  const run = `connected-walk-${Date.now()}`, evidenceFile = join(directory, `${run}-evidence.json`);
  const report = { version: 1, run, status: "needs_review", generation_submissions: 0, started_at: new Date().toISOString(),
    controls: "Actual W/A/S/D keyboard, genuine pointer yaw, Rapier capsule collision and unchanged app autosave requests",
    checkpoints: [], observations: [], movement: [], autosaves: [], rejected_autosaves: [], checks: {} };
  let viewport, plan, before, ownsAutosave = false, inFlight = 0, lastObserved, persistence = Promise.resolve(); const errors = [];
  const walkPath = `/api/creator/worlds/${manifest.world.session_id}/walk`;
  const persist = () => { persistence = persistence.then(() => saveJson(evidenceFile, report)); return persistence; };
  const release = async () => { for (const key of keys) await page.keyboard.up(key).catch(() => {}); };
  const observe = async () => {
    if (errors.length) throw new Error(errors[0]);
    const attributes = await viewport.evaluate(element => ({ mode: element.dataset.mode, camera: element.dataset.camera,
      yaw: element.dataset.yaw, place_id: element.dataset.placeId, loaded_places: element.dataset.loadedPlaces, pose_restore: element.dataset.poseRestore }));
    assert.equal(attributes.mode, "walk"); assert.equal(Number(attributes.loaded_places), plan.chunks.length, "Actual viewport loaded a different connected network");
    assert.ok(plan.chunks.some(chunk => chunk.scene.place_id === attributes.place_id), "Observed walker left the saved connected chunks");
    lastObserved = { ...parsePilotWalkObservation(attributes.camera, attributes.yaw), place_id: attributes.place_id,
      pose_restore: attributes.pose_restore ?? null, observed_at: Date.now() };
    report.observations.push(lastObserved); return lastObserved;
  };
  try {
    before = await readNetwork(); normalizedPilotChunks(before, manifest.world.session_id);
    plan = derivePilotConnectedWalkPlan(before, manifest.world.place_id); report.plan = plan;
    if (!plan.supported) { report.status = "unsupported"; report.reason = plan.reason; return report; }
    report.network_sha256 = pilotReviewHash(before);
    assert.ok(!approvedUiWrites.has(walkPath), "Another handler already owns walk autosaves");
    viewport = page.locator('[data-testid="place-viewport"][data-mode="walk"]').first();
    approvedUiWrites.set(walkPath, async (route, body) => {
      inFlight++;
      try {
        assert.equal(route.request().method(), "POST"); assert.equal(new URL(route.request().url()).pathname, walkPath);
        if (await viewport.count()) await observe();
        assert.ok(lastObserved, "No genuine physics frame is available for autosave");
        const validated = validatePilotConnectedAutosave(body, plan.chunks, report.observations);
        const response = await route.fetch({ maxRedirects: 0 }), text = await response.text(), saved = JSON.parse(text);
        assert.ok(response.ok(), `Actual app autosave rejected (${response.status()})`);
        assert.equal(saved.revision, body.base_revision + 1); assert.deepEqual(saved.pose, body.pose);
        report.autosaves.push({ at: new Date().toISOString(), request_id: body.request_id, input_sha256: pilotReviewHash(body),
          observed_global_camera: lastObserved, matched_local_camera: validated.matched_local_camera,
          chunk_origin: { x: validated.chunk.x, z: validated.chunk.z }, saved });
        await route.fulfill({ response, body: text }); await persist();
      } catch (error) {
        report.rejected_autosaves.push({ at: new Date().toISOString(), body, current_camera: lastObserved,
          recent_camera_history: report.observations.slice(-40), reason: error.message });
        errors.push(error.message); await persist(); await route.abort().catch(() => {});
      } finally { inFlight--; }
    }); ownsAutosave = true;
    await page.setViewportSize({ width: 1024, height: 820 }); await navigate("walk");
    await viewport.scrollIntoViewIfNeeded(); await viewport.locator("canvas").click({ position: { x: 40, y: 40 } });
    const initial = await observe(); report.initial = initial;
    assert.ok(initial.place_id === plan.root_id && distance(initial, plan.points[0]) < 0.35
      && Math.abs(initial.y - plan.expected_eye_y) < 0.35, "Saved starting physics position differs from the root entrance; no synthetic reset is allowed");
    const alignNorth = async () => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const sample = await observe(); if (Math.abs(sample.yaw) < 0.003) return;
        const box = await viewport.locator("canvas").boundingBox(); assert.ok(box?.width > 150 && box.height > 150);
        const dx = Math.max(-Math.min(120, box.width * 0.3), Math.min(Math.min(120, box.width * 0.3), sample.yaw / 0.005));
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        try { await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 }); }
        finally { await page.mouse.up(); }
        await page.waitForTimeout(120); report.movement.push({ control: "pointer-yaw", before: sample, after: await observe() });
      }
      throw new Error("Actual pointer yaw alignment did not converge");
    };
    const moveAxis = async (axis, target, label) => {
      await alignNorth(); const start = await observe(), delta = target - start[axis]; if (Math.abs(delta) <= 0.07) return;
      const sign = Math.sign(delta), key = axis === "x" ? sign > 0 ? "d" : "a" : sign > 0 ? "s" : "w";
      const deadline = Date.now() + Math.min(90_000, Math.max(20_000, Math.abs(delta) / 0.2 * 1000 + 5000));
      let last = start, movedAt = Date.now();
      const progress = sample => {
        if (Math.abs(sample[axis] - last[axis]) > 0.01) { movedAt = Date.now(); last = sample; }
        if (Date.now() - movedAt > 4500) throw new Error(`Actual capsule movement blocked during ${label}`);
        if (Date.now() > deadline) throw new Error(`Actual movement timed out during ${label}`);
      };
      if (Math.abs(delta) > 1.4) {
        await page.keyboard.down(key);
        try { for (;;) { await page.waitForTimeout(60); const sample = await observe(); progress(sample); if (sign * (target - sample[axis]) <= 1.1) break; } }
        finally { await page.keyboard.up(key); }
        await page.waitForTimeout(70); last = await observe(); movedAt = Date.now();
      }
      for (;;) {
        const sample = await observe(), pulse = pilotWalkPulse(axis, target - sample[axis]); if (!pulse) break;
        await page.keyboard.press(pulse.key, { delay: pulse.delay }); await page.waitForTimeout(70);
        const after = await observe(); progress(after); report.movement.push({ label, control: "keyboard-pulse", key: pulse.key,
          delay_ms: pulse.delay, axis, target, before: sample, after });
      }
      const after = await observe(); assert.ok(Math.abs(after[axis] - target) <= 0.25, `Actual walker overshot ${label}`);
      report.movement.push({ label, control: key, axis, target, before: start, after });
    };
    const moveTo = async point => { await moveAxis("x", point.x, point.label); await moveAxis("z", point.z, point.label); };
    const checkpoint = async (point, label = point.label, interior = false) => {
      await release(); await page.waitForTimeout(650); const camera = await observe();
      assert.ok(camera.place_id === point.place_id && distance(camera, point) < 0.3 && Math.abs(camera.y - plan.expected_eye_y) < 0.35, `Actual ${label} camera is outside its expected place/height/position`);
      const chunk = plan.chunks.find(item => item.scene.place_id === point.place_id), deadline = Date.now() + 12_000;
      let saved;
      for (;;) {
        if (errors.length) throw new Error(errors[0]); saved = await get(walkPath); const pose = saved.pose;
        const wanted = interior ? { building_id: plan.building_id, floor_id: plan.floor_id, ...(plan.room_id ? { room_id: plan.room_id } : {}) } : null;
        if (pose?.place_id === point.place_id && pose.scene_revision === chunk.scene.revision
          && distance({ x: pose.position.x + chunk.x, z: pose.position.z + chunk.z }, camera) < 0.25
          && Math.abs(pose.position.y + 0.78 - camera.y) < 0.3 && pilotReviewHash(pose.space) === pilotReviewHash(wanted)) break;
        if (Date.now() > deadline) throw new Error(`Actual ${label} autosave did not acknowledge the authoritative local space`);
        await page.waitForTimeout(500);
      }
      const room = page.getByRole("status", { name: "Current room", exact: true });
      const room_text = await room.count() ? await room.first().textContent() : null;
      if (interior) assert.ok(room_text?.includes(plan.building_label) && room_text.includes(plan.floor_label), "The live tea lounge room label is missing");
      const screenshot = `${run}-${label}.png`; await page.screenshot({ path: join(directory, screenshot), fullPage: false }); await chmod(join(directory, screenshot), 0o600);
      const entry = { label, camera, saved, room_text, screenshot, at: new Date().toISOString() }; report.checkpoints.push(entry);
      await persist(); await log("connected_walk_checkpoint", { label, place_id: camera.place_id, camera, space: saved.pose.space }); return entry;
    };
    await checkpoint(plan.points[0]);
    for (const point of plan.points.slice(1)) { await moveTo(point); await checkpoint(point, point.label, point === plan.points.at(-1)); }
    report.checks.real_boundary_handoff = report.checkpoints.some(entry => entry.label === "annex-handoff" && entry.saved.pose.place_id === plan.annex_id);
    report.checks.second_structured_building_entered = true;
    const inside = plan.points.at(-1), beforeRestore = await get(walkPath);
    await navigate("orbit"); await page.waitForTimeout(500); await navigate("walk"); await viewport.scrollIntoViewIfNeeded();
    const restored = await checkpoint(inside, "restored-tea-lounge", true), annexChunk = plan.chunks.find(chunk => chunk.scene.place_id === plan.annex_id);
    report.checks.connected_position_restored = restored.camera.pose_restore === "restored"
      && distance(restored.camera, { x: beforeRestore.pose.position.x + annexChunk.x, z: beforeRestore.pose.position.z + annexChunk.z }) < 0.3;
    assert.ok(report.checks.connected_position_restored, "Reload did not restore the actual saved annex interior position");
    for (const point of plan.points.slice(0, -1).reverse()) { await moveTo(point); await checkpoint(point, `return-${point.label}`); }
    report.checks.real_reverse_boundary_handoff = report.checkpoints.some(entry => entry.label === "return-root-portal-approach" && entry.saved.pose.place_id === plan.root_id);
    report.checks.physical_return_to_root_entrance = true;
    const finalPose = await get(walkPath); await navigate("orbit"); await page.waitForTimeout(500); await navigate("walk"); await viewport.scrollIntoViewIfNeeded();
    const final = await checkpoint(plan.points[0], "restored-root-entrance"), rootChunk = plan.chunks.find(chunk => chunk.scene.place_id === plan.root_id);
    report.checks.root_position_restored = final.camera.pose_restore === "restored"
      && distance(final.camera, { x: finalPose.pose.position.x + rootChunk.x, z: finalPose.pose.position.z + rootChunk.z }) < 0.3;
    assert.ok(report.checks.root_position_restored, "Reload did not restore the final actual root position");
    const after = await readNetwork(); report.after_network_sha256 = pilotReviewHash(after);
    report.checks.all_saved_geometry_and_connections_unchanged = report.after_network_sha256 === report.network_sha256;
    assert.ok(Object.values(report.checks).every(Boolean), "Connected physical proof is incomplete"); report.status = "passed";
    return report;
  } catch (error) {
    report.reason = error.message;
    if (viewport) { report.failure_camera = await observe().catch(() => lastObserved ?? null); const file = join(directory, `${run}-failure.png`);
      await page.screenshot({ path: file, fullPage: false }).then(() => chmod(file, 0o600)).catch(() => {}); }
    return report;
  } finally {
    await release(); if (viewport) await navigate("orbit").catch(() => {});
    const deadline = Date.now() + 6000; while (inFlight && Date.now() < deadline) await page.waitForTimeout(100);
    if (ownsAutosave) approvedUiWrites.delete(walkPath);
    report.checks.no_rejected_autosaves = !errors.length && !inFlight;
    if (report.status === "passed" && !report.checks.no_rejected_autosaves) { report.status = "needs_review"; report.reason = errors[0] ?? "Final autosave remains pending"; }
    report.finished_at = new Date().toISOString(); await persist(); await saveJson(join(directory, "connected-walk-result.json"), report);
    await log("connected_walk_result", { status: report.status, checks: report.checks, reason: report.reason ?? null });
  }
}

async function privateFile(file) {
  const info = await lstat(file); assert.ok(info.isFile() && !(info.mode & 0o077), "Pilot receipt and ownership must be private (0600)");
  return JSON.parse(await readFile(file, "utf8"));
}
async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("quality-pilot-connected-walk.mjs --environment <private environment.json>\nFree actual connected walking. Only scoped app position autosaves may write."); return; }
  assert.ok(values.environment, "--environment is required");
  const environment = resolve(values.environment), directory = dirname(environment), receipt = await privateFile(environment);
  const manifest = await privateFile(join(directory, "pilot-manifest.json")); validatePilotReviewEnvironment(receipt, environment, manifest);
  assert.equal(manifest.phases?.expansion?.status, "complete", "Finish the saved annex expansion before actual connected walking");
  const state = await privateFile(join(directory, "browser-state.json"));
  const harnessLock = await open(join(directory, "harness.lock"), "wx", 0o600).catch(() => { throw new Error("A pilot harness is active; finish it before connected walking"); });
  const lock = join(directory, ".quality-pilot.lock"); let ownsLock = false, browser, context, result;
  const run = `connected-walk-run-${Date.now()}`;
  try {
    await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("Another pilot phase is active; finish it before connected walking"); }); ownsLock = true;
    browser = await chromium.launch({ headless: true, slowMo: 0 });
    const videoDir = join(directory, run); await mkdir(videoDir, { mode: 0o700 });
    context = await browser.newContext({ baseURL: receipt.origin, storageState: state, serviceWorkers: "block",
      viewport: { width: 1024, height: 820 }, recordVideo: { dir: videoDir, size: { width: 1024, height: 820 } } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); const page = await context.newPage(); page.setDefaultTimeout(60_000);
    const approvedUiWrites = new Map(), rejectedWrites = [];
    await page.route("**/*", async route => {
      const request = route.request(); if (["GET", "HEAD"].includes(request.method())) return route.continue();
      const path = new URL(request.url()).pathname, handler = approvedUiWrites.get(path);
      if (request.method() !== "POST" || !handler || new URL(request.url()).origin !== new URL(receipt.origin).origin) {
        rejectedWrites.push({ method: request.method(), path }); return route.abort("blockedbyclient");
      }
      await handler(route, request.postDataJSON());
    });
    const scenePrefix = `/api/world/${manifest.world.session_id}/places/${manifest.world.place_id}`;
    const get = async path => { assert.ok(path === `${scenePrefix}/connections` || path === `/api/creator/worlds/${manifest.world.session_id}/walk`);
      const response = await page.request.get(`${receipt.origin}${path}`, { maxRedirects: 0 }); assert.ok(response.ok(), `Owned read failed (${response.status()})`); return response.json(); };
    const readNetwork = async () => { const value = await get(`${scenePrefix}/connections`); assert.ok(value.network); return value.network; };
    const navigate = async mode => { assert.ok(["walk", "orbit"].includes(mode));
      await page.goto(`/sketch/world?${new URLSearchParams({ world: manifest.world.session_id, place: manifest.world.place_id, view: mode })}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator(`[data-testid="place-viewport"][data-mode="${mode}"]`).first()).toHaveAttribute("data-ready", "true"); };
    result = await verifyPilotConnectedWalk({ page, manifest, directory, approvedUiWrites, get, navigate, readNetwork });
    if (rejectedWrites.length) { result.status = "needs_review"; result.unapproved_browser_writes = rejectedWrites; }
    await context.tracing.stop({ path: join(directory, `${run}-trace.zip`) }); await chmod(join(directory, `${run}-trace.zip`), 0o600);
    await context.close(); context = null; result.video = await page.video().path(); await chmod(result.video, 0o600);
    await atomicJson(join(directory, `${result.run}-evidence.json`), result); await atomicJson(join(directory, "connected-walk-result.json"), result);
    console.log(JSON.stringify({ status: result.status, checks: result.checks, report: join(directory, `${result.run}-evidence.json`), reason: result.reason ?? null }));
    if (result.status !== "passed") process.exitCode = 1;
  } finally { await context?.close(); await browser?.close(); if (ownsLock) await rm(lock, { recursive: true }); await harnessLock.close(); await rm(join(directory, "harness.lock")); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
