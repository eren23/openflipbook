/** Free acceptance evidence from ordinary browser controls and the app's Rapier walk.
 * No camera/body setters, route handoffs, synthetic poses or provider requests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finite = value => typeof value === "number" && Number.isFinite(value);
const wrap = value => Math.atan2(Math.sin(value), Math.cos(value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const keys = ["w", "a", "s", "d"];

/** The renderer subtracts the whole network's minimum x/z, so added west or
 * north chunks shift its live camera while persisted poses stay place-local.
 * This read-only frame is derived fresh and never changes either actual pose.
 */
export function derivePilotRootWalkFrame(network, world, scene) {
  assert.equal(scene.place_id, world.place_id, "Saved root scene belongs to another place");
  assert.equal(scene.session_id, world.session_id, "Saved root scene belongs to another world");
  const base = { place_id: world.place_id, width: scene.definition.width, depth: scene.definition.depth };
  if (network === null) return { ...base, connected: false, loaded_places: 1, origin: { x: 0, z: 0 }, network_sha256: hash(null) };
  assert.ok(Array.isArray(network?.chunks) && network.chunks.length >= 2 && network.chunks.length <= 16, "Malformed saved connected network");
  assert.ok(Array.isArray(network.connections), "Saved connection graph is missing");
  const ids = new Set();
  for (const chunk of network.chunks) {
    assert.ok([chunk.x, chunk.z, chunk.scene?.definition?.width, chunk.scene?.definition?.depth].every(finite), "Invalid saved chunk frame");
    assert.ok(typeof chunk.scene.place_id === "string" && !ids.has(chunk.scene.place_id), "Duplicate saved network place"); ids.add(chunk.scene.place_id);
    assert.equal(chunk.scene.session_id, world.session_id, "Connected chunk belongs to another world");
    assert.ok(Number.isSafeInteger(chunk.scene.revision) && chunk.scene.revision >= 1, "Invalid saved connected revision");
  }
  const root = network.chunks.find(chunk => chunk.scene.place_id === world.place_id);
  assert.ok(root, "Saved root chunk is missing");
  assert.equal(root.scene.id, scene.id, "Connected root scene identity changed");
  assert.equal(root.scene.revision, scene.revision, "Connected root revision changed");
  assert.equal(hash(root.scene.definition), hash(scene.definition), "Connected root definition differs from saved scene");
  const minX = Math.min(...network.chunks.map(chunk => chunk.x)), minZ = Math.min(...network.chunks.map(chunk => chunk.z));
  return { ...base, connected: true, loaded_places: network.chunks.length,
    origin: { x: root.x - minX, z: root.z - minZ }, network_sha256: hash(network),
    sources: network.chunks.map(chunk => ({ place_id: chunk.scene.place_id, scene_id: chunk.scene.id,
      revision: chunk.scene.revision, definition_sha256: hash(chunk.scene.definition), x: chunk.x - minX, z: chunk.z - minZ })) };
}

export function pilotRootWalkObservation(attributes, frame, observedAt = Date.now()) {
  assert.equal(attributes.mode, "walk", "The active viewport is not the physics Walk view");
  assert.equal(Number(attributes.loaded_places), frame.loaded_places, "Actual viewport loaded a different saved network");
  if (frame.connected || attributes.place_id) assert.equal(attributes.place_id, frame.place_id, "Actual workshop walker left the owned root place");
  const globalCamera = parsePilotWalkObservation(attributes.camera, attributes.yaw);
  const x = globalCamera.x - frame.origin.x, z = globalCamera.z - frame.origin.z;
  assert.ok(x >= 0 && x <= frame.width && z >= 0 && z <= frame.depth, "Observed camera is outside its saved root-local frame");
  return { ...globalCamera, x, z, observed_at: observedAt, place_id: frame.place_id,
    global_camera: globalCamera, root_origin: frame.origin };
}

const exteriorSegmentHits = (a, b, object) => {
  if (object.placement || ["path", "pond"].includes(object.kind)) return false;
  if (![object.x, object.z, object.width, object.depth, object.heading].every(finite)) return true;
  const c = Math.abs(Math.cos(object.heading)), s = Math.abs(Math.sin(object.heading));
  const w = (object.width * c + object.depth * s) / 2 + 0.35, d = (object.depth * c + object.width * s) / 2 + 0.35;
  return Math.max(a.x, b.x) > object.x - w && Math.min(a.x, b.x) < object.x + w
    && Math.max(a.z, b.z) > object.z - d && Math.min(a.z, b.z) < object.z + d;
};

/** Limited, explicit geometry support; unknown layouts never become passing evidence. */
export function derivePilotWalkPlan(definition) {
  const unsupported = reason => ({ supported: false, reason });
  if (!definition || definition.version !== 2 || !Array.isArray(definition.objects)) return unsupported("A saved version-2 place is required");
  const matches = definition.objects.filter(object => object.kind === "building" && object.label === "Copper Workshop");
  if (matches.length !== 1) return unsupported("Exactly one named Copper Workshop is required");
  const building = matches[0], structure = building.structure, door = structure?.door;
  if (![building.x, building.z, building.width, building.depth, building.height, building.heading, structure?.wall_thickness, structure?.roof_height].every(finite)
    || Math.abs(building.heading) > 1e-8 || structure.footprint || structure.floors?.length !== 2
    || !door || door.side !== "south" || door.wall_id || door.floor !== 0 || door.sill !== 0 || door.width < 1.1) return unsupported("Only a rectangular heading-zero two-storey workshop with a ground south door is supported");
  const partition = structure.floors[0].layout, upper = structure.floors[1].layout;
  if (partition?.type !== "split" || partition.axis !== "x" || partition.a?.type !== "room" || partition.b?.type !== "room" || upper?.type !== "room"
    || ![partition.position, partition.door?.offset, partition.door?.width, door.offset].every(finite)
    || partition.door.width < 1.1 || door.offset <= partition.position + structure.wall_thickness / 2 + 0.4) return unsupported("The supported ground plan needs one x partition, two rooms and a south doorway into its right room");
  if (structure.stair && (structure.stair.direction !== "north" || ![structure.stair.x, structure.stair.z].every(finite))) return unsupported("Only the saved or default north stair is supported");
  const level = (building.height - structure.roof_height) / 2;
  if (!finite(level) || level < 2.6 || level > 4.5) return unsupported("Invalid saved storey height");
  // Same published geometry contract as buildingStair/buildingParts, not a new scene.
  const steps = Math.ceil(level / 0.18), run = steps * 0.25;
  const stair = { x: structure.stair?.x ?? -building.width / 2 + structure.wall_thickness + 0.8,
    z: structure.stair?.z ?? -building.depth / 2 + structure.wall_thickness + 0.8 + run / 2,
    width: 1.2, steps, run, level };
  const bounds = { x1: -building.width / 2 + structure.wall_thickness, x2: building.width / 2 - structure.wall_thickness,
    z1: -building.depth / 2 + structure.wall_thickness, z2: building.depth / 2 - structure.wall_thickness };
  const crossing = structure.wall_thickness / 2 + 0.7;
  const left = partition.position - crossing, right = partition.position + crossing;
  const bottom = stair.z + run / 2 + 0.75, top = stair.z - run / 2 - 0.38;
  const clearX = stair.x + stair.width / 2 + 0.6;
  const local = {
    outside: { x: door.offset, z: building.depth / 2 + 1.1 },
    inside: { x: door.offset, z: building.depth / 2 - structure.wall_thickness - 0.8 },
    craft: { x: Math.max(door.offset, right), z: partition.door.offset },
    hall: { x: left, z: partition.door.offset },
    stair_bottom: { x: stair.x, z: bottom }, stair_top: { x: stair.x, z: top },
    upper_clear: { x: clearX, z: top }, upper_room: { x: clearX + 0.6, z: stair.z },
  };
  for (const [name, point] of Object.entries(local)) {
    if (name === "outside") continue;
    if (point.x < bounds.x1 + 0.32 || point.x > bounds.x2 - 0.32 || point.z < bounds.z1 + 0.32 || point.z > bounds.z2 - 0.32) return unsupported(`The ${name} route lacks capsule clearance inside the saved walls`);
  }
  if (stair.x + stair.width / 2 + 0.32 >= partition.position - structure.wall_thickness / 2
    || bottom >= partition.door.offset - 0.15) return unsupported("The supported stair approach must be in the left room south of the flight");
  const point = p => ({ x: building.x + p.x, z: building.z + p.z });
  const points = Object.fromEntries(Object.entries(local).map(([name, value]) => [name, point(value)]));
  const entrance = definition.entrance;
  if (!entrance || ![entrance.x, entrance.z, entrance.yaw].every(finite) || entrance.z < points.outside.z + 0.5) return unsupported("The saved entrance must be outside south of the workshop approach");
  // Axis-aligned approach must not cross another physical exterior object.
  const turn = { x: points.outside.x, z: entrance.z };
  if (definition.objects.some(object => exteriorSegmentHits(entrance, turn, object) || exteriorSegmentHits(turn, points.outside, object))) return unsupported("Another saved exterior object intersects the conservative entrance approach");
  return { supported: true, building_id: building.id, building_label: building.label, heading: building.heading,
    ground_floor_id: structure.floors[0].id, upper_floor_id: structure.floors[1].id,
    craft_room_id: partition.b.id, hall_room_id: partition.a.id, upper_room_id: upper.id,
    partition_id: partition.id, partition_door_id: partition.door.id, exterior_door_id: door.id,
    stair, expected_ground_eye_y: 1.6, expected_upper_eye_y: 1.6 + level,
    entrance: { x: entrance.x, z: entrance.z }, points };
}

export function derivePilotWalkResume(definition, plan, observed) {
  if (!plan.supported || !observed || ![observed.x, observed.y, observed.z].every(finite)
    || Math.abs(observed.y - plan.expected_ground_eye_y) > 0.3) return { supported: false, reason: "The saved start is not a measured ground-level exterior position" };
  if (distance(observed, plan.entrance) <= 0.3) return { supported: true, waypoints: [] };
  if (observed.z < plan.points.outside.z || observed.x < 0.35 || observed.x > definition.width - 0.35 || observed.z > definition.depth - 0.35) {
    return { supported: false, reason: "The saved position is outside the supported south approach; no reset or synthetic pose is allowed" };
  }
  const turn = { x: plan.entrance.x, z: observed.z };
  if (definition.objects.some(object => exteriorSegmentHits(observed, turn, object) || exteriorSegmentHits(turn, plan.entrance, object))) {
    return { supported: false, reason: "Saved exterior obstacles block the conservative physical return to the entrance" };
  }
  return { supported: true, waypoints: [turn, plan.entrance] };
}

export function parsePilotWalkObservation(camera, yaw) {
  const values = typeof camera === "string" ? camera.split(",").map(part => part.trim() ? Number(part) : NaN) : [];
  const angle = typeof yaw === "string" && yaw.trim() ? Number(yaw) : NaN;
  if (values.length !== 3 || !values.every(Number.isFinite) || !finite(angle)) throw new Error("The live walk viewport has no finite camera/yaw observation");
  return { x: values[0], y: values[1], z: values[2], yaw: wrap(angle) };
}

export function pilotWalkPulse(axis, remaining) {
  if (!["x", "z"].includes(axis) || !finite(remaining)) throw new Error("Invalid measured walking target");
  if (Math.abs(remaining) <= 0.07) return null;
  return { key: axis === "x" ? remaining > 0 ? "d" : "a" : remaining > 0 ? "s" : "w",
    // Ordinary character speed is 2.5m/s: these presses request at most 15cm
    // or 7.5cm of simulated travel, with no held key during the next DOM read.
    delay: Math.abs(remaining) > 0.22 ? 60 : 30 };
}

/** All writes are intercepted ordinary app autosaves, restricted to this saved scene. */
export function matchPilotWalkObservation(pose, observations, now = Date.now()) {
  const history = Array.isArray(observations) ? observations : [observations];
  const candidates = history.filter(observed => observed && [observed.x, observed.y, observed.z, observed.yaw].every(finite)
    && (!Array.isArray(observations) || finite(observed.observed_at) && now - observed.observed_at >= -100 && now - observed.observed_at <= 6000)
    && distance(pose.position, observed) <= 0.55 && Math.abs(pose.position.y + 0.78 - observed.y) <= 0.4
    && Math.abs(wrap(pose.yaw - observed.yaw)) <= 0.2);
  candidates.sort((a, b) => distance(pose.position, a) - distance(pose.position, b));
  return candidates[0] ?? null;
}

export function validatePilotWalkAutosave(body, world, scene, observations) {
  if (!body || !Number.isSafeInteger(body.base_revision) || body.base_revision < 0
    || typeof body.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) throw new Error("Invalid app walking-position request");
  const pose = body.pose, p = pose?.position;
  if (!pose || pose.version !== 1 || pose.place_id !== world.place_id || pose.scene_revision !== scene.revision
    || !p || ![p.x, p.y, p.z, pose.yaw, pose.pitch].every(finite) || p.x < 0 || p.x > scene.definition.width
    || p.z < 0 || p.z > scene.definition.depth || p.y < 0.8 || p.y > 20 || Math.abs(pose.yaw) > Math.PI || Math.abs(pose.pitch) > 1.1) throw new Error("App walk autosave left the owned saved scene");
  if (!matchPilotWalkObservation(pose, observations)) throw new Error("App walking-position request does not match recent measured physics camera history");
  return pose;
}

export async function verifyPilotWalk({ page, manifest, directory, approvedUiWrites, get, navigate, readScene, log, atomicJson }) {
  const run = `walk-${Date.now()}`, evidenceFile = join(directory, `${run}-evidence.json`);
  const report = { version: 1, run, status: "needs_review", generation_submissions: 0,
    controls: "Ordinary W/A/S/D keyboard input; pointer drag to align yaw; app Rapier physics and autosave only",
    checkpoints: [], movement: [], observations: [], autosaves: [], rejected_autosaves: [], checks: {}, started_at: new Date().toISOString() };
  let viewport, walkPath, coordinateFrame, ownsAutosave = false, lastObserved, inFlight = 0, persistence = Promise.resolve(); const saveErrors = [];
  const persist = () => { persistence = persistence.then(() => atomicJson(evidenceFile, report)); return persistence; };
  const release = async () => { for (const key of keys) await page.keyboard.up(key).catch(() => {}); };
  const observe = async () => {
    if (saveErrors.length) throw new Error(saveErrors[0]);
    // One read-only DOM operation samples these attributes in the same browser
    // turn. Separate CDP reads under slowMo can otherwise mix future frames.
    const attributes = await viewport.evaluate(element => ({ mode: element.dataset.mode, camera: element.dataset.camera,
      yaw: element.dataset.yaw, place_id: element.dataset.placeId, loaded_places: element.dataset.loadedPlaces }));
    lastObserved = pilotRootWalkObservation(attributes, coordinateFrame);
    report.observations.push(lastObserved);
    return lastObserved;
  };
  try {
    assert.ok(manifest.world?.session_id && manifest.world?.place_id, "Saved isolated pilot world missing");
    const scene = await readScene(), plan = derivePilotWalkPlan(scene.definition);
    report.scene = { place_id: manifest.world.place_id, revision: scene.revision, definition_sha256: hash(scene.definition) }; report.plan = plan;
    if (!plan.supported) { report.status = "unsupported"; report.reason = plan.reason; return report; }
    const connectionsPath = `/api/world/${manifest.world.session_id}/places/${manifest.world.place_id}/connections`;
    const savedConnections = await get(connectionsPath);
    coordinateFrame = derivePilotRootWalkFrame(savedConnections.network, manifest.world, scene);
    report.coordinate_frame = coordinateFrame;
    walkPath = `/api/creator/worlds/${manifest.world.session_id}/walk`;
    if (approvedUiWrites.has(walkPath)) { report.status = "unsupported"; report.reason = "Another scoped handler already owns walking-position writes"; return report; }
    viewport = page.locator('[data-testid="place-viewport"][data-mode="walk"]').first();
    approvedUiWrites.set(walkPath, async (route, body) => {
      inFlight++;
      try {
        assert.equal(route.request().method(), "POST"); assert.equal(new URL(route.request().url()).pathname, walkPath);
        // React closes the sync queue when leaving Walk. Its final genuine save
        // is checked against the last measured physics frame, never an orbit pose.
        const walking = await viewport.count();
        const observed = walking ? await observe() : lastObserved;
        assert.ok(observed, "The app has no measured physics frame for this autosave");
        const history = report.observations.filter(sample => observed.observed_at - sample.observed_at <= 6000);
        validatePilotWalkAutosave(body, manifest.world, scene, history);
        const matched = matchPilotWalkObservation(body.pose, history);
        const response = await route.fetch({ maxRedirects: 0 }), text = await response.text(), saved = JSON.parse(text);
        assert.ok(response.ok(), `App walk autosave rejected (${response.status()})`);
        assert.equal(saved.revision, body.base_revision + 1); assert.deepEqual(saved.pose, body.pose);
        report.autosaves.push({ at: new Date().toISOString(), request_id: body.request_id, base_revision: body.base_revision,
          revision: saved.revision, input_sha256: hash(body), observed_camera: observed, matched_history_camera: matched, saved });
        await route.fulfill({ response, body: text }); await persist();
      } catch (error) {
        report.rejected_autosaves.push({ at: new Date().toISOString(), body, current_camera: lastObserved,
          recent_camera_history: report.observations.slice(-30), reason: error.message });
        saveErrors.push(error.message); await persist(); await route.abort().catch(() => {});
      }
      finally { inFlight--; }
    });
    ownsAutosave = true;
    await page.setViewportSize({ width: 1024, height: 820 }); await navigate("walk");
    // The actual mode is checked on every observation; no URL route/pose handoff is used.
    await viewport.scrollIntoViewIfNeeded(); await viewport.locator("canvas").click({ position: { x: 40, y: 40 } });
    const initial = await observe(); report.initial = initial;
    const resume = derivePilotWalkResume(scene.definition, plan, initial); report.resume = resume;
    if (!resume.supported) { report.status = "unsupported"; report.reason = resume.reason; return report; }
    const alignNorth = async () => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const before = await observe(); if (Math.abs(before.yaw) < 0.003) return;
        const box = await viewport.locator("canvas").boundingBox(); assert.ok(box?.width > 150 && box.height > 150, "Walking canvas is not usable");
        const dx = Math.max(-Math.min(120, box.width * 0.3), Math.min(Math.min(120, box.width * 0.3), before.yaw / 0.005));
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        try { await page.mouse.move(x + dx, y, { steps: 4 }); } finally { await page.mouse.up(); }
        await page.waitForTimeout(120);
        report.movement.push({ control: "pointer-yaw", before, after: await observe() });
      }
      throw new Error("Ordinary pointer yaw alignment did not converge");
    };
    const moveAxis = async (axis, target, label) => {
      await alignNorth(); const before = await observe(), delta = target - before[axis];
      if (Math.abs(delta) <= 0.07) return;
      const sign = Math.sign(delta), key = axis === "x" ? sign > 0 ? "d" : "a" : sign > 0 ? "s" : "w";
      const deadline = Date.now() + Math.min(90_000, Math.max(20_000, Math.abs(delta) / 0.2 * 1000 + 5000));
      let movedAt = Date.now(), last = before;
      const progress = current => {
        if (Math.abs(current[axis] - last[axis]) > 0.01) { movedAt = Date.now(); last = current; }
        if (Date.now() - movedAt > 4500) throw new Error(`Actual physics movement blocked during ${label}; no pose reset or alternate route used`);
        if (Date.now() > deadline) throw new Error(`Actual physics movement timed out during ${label}`);
      };
      // Brake well before the waypoint. A CDP observation can finish after its
      // sampled frame while a held key continues moving; slowMo amplified this
      // in the preserved first live walk. Precision reads always happen key-up.
      if (Math.abs(delta) > 1.4) {
        await page.keyboard.down(key);
        try {
          for (;;) {
            await page.waitForTimeout(60); const current = await observe(); progress(current);
            if (sign * (target - current[axis]) <= 1.1) break;
          }
        } finally { await page.keyboard.up(key); }
        await page.waitForTimeout(70); last = await observe(); movedAt = Date.now();
      }
      for (;;) {
        const current = await observe(), pulse = pilotWalkPulse(axis, target - current[axis]);
        if (!pulse) break;
        await page.keyboard.press(pulse.key, { delay: pulse.delay });
        await page.waitForTimeout(70); const measured = await observe(); progress(measured);
        report.movement.push({ label, control: "keyboard-pulse", key: pulse.key, delay_ms: pulse.delay, axis, target, before: current, after: measured });
      }
      const after = await observe(); report.movement.push({ label, control: key, axis, target, before, after });
      if (Math.abs(after[axis] - target) > 0.25) throw new Error(`Ordinary walking overshot ${label}`);
    };
    const moveTo = async (point, label) => { await moveAxis("x", point.x, label); await moveAxis("z", point.z, label); };
    const savedAt = async (wanted, observed) => {
      const deadline = Date.now() + 12_000;
      for (;;) {
        if (saveErrors.length) throw new Error(saveErrors[0]);
        const saved = await get(walkPath), pose = saved.pose;
        const matches = pose && pose.place_id === manifest.world.place_id && pose.scene_revision === scene.revision
          && distance(pose.position, observed) < 0.25 && Math.abs(pose.position.y + 0.78 - observed.y) < 0.3
          && (wanted === null ? pose.space === null : pose.space?.building_id === plan.building_id
            && pose.space?.floor_id === wanted.floor_id && (!wanted.room_id || pose.space?.room_id === wanted.room_id));
        if (matches) return saved;
        if (Date.now() > deadline) throw new Error("Actual walking-position save did not acknowledge the observed building/floor/room");
        await page.waitForTimeout(500);
      }
    };
    const checkpoint = async (label, wanted, expectedY) => {
      await release(); await page.waitForTimeout(650); const camera = await observe();
      if (Math.abs(camera.y - expectedY) > 0.35) throw new Error(`${label} has unexpected actual eye height ${camera.y}`);
      const saved = await savedAt(wanted, camera), room = page.getByRole("status", { name: "Current room", exact: true });
      const room_text = await room.count() ? await room.first().textContent() : null;
      const screenshot = `${run}-${label}.png`; await page.screenshot({ path: join(directory, screenshot), fullPage: false });
      const entry = { label, camera, room_text, saved, screenshot, at: new Date().toISOString() }; report.checkpoints.push(entry);
      await persist(); await log("walk_checkpoint", { label, camera, space: saved.pose.space ?? null }); return entry;
    };
    const ground = room_id => ({ floor_id: plan.ground_floor_id, room_id });
    const upper = { floor_id: plan.upper_floor_id, room_id: plan.upper_room_id };
    if (resume.waypoints.length) {
      await checkpoint("saved-exterior-start", null, plan.expected_ground_eye_y);
      for (const point of resume.waypoints) await moveTo(point, "physical resume approach to entrance");
      report.checks.saved_exterior_resumed_with_controls = true;
    }
    await checkpoint("entrance", null, plan.expected_ground_eye_y);
    await moveTo(plan.points.outside, "workshop exterior approach"); await checkpoint("outside-door", null, plan.expected_ground_eye_y);
    await moveTo(plan.points.inside, "saved exterior doorway"); await checkpoint("ground-craft", ground(plan.craft_room_id), plan.expected_ground_eye_y);
    report.checks.exterior_door_traversed = true;
    await moveTo(plan.points.craft, "interior doorway approach");
    await moveTo(plan.points.hall, "saved partition doorway"); await checkpoint("ground-hall", ground(plan.hall_room_id), plan.expected_ground_eye_y);
    report.checks.partition_door_traversed = true;
    await moveTo(plan.points.stair_bottom, "stair bottom"); await checkpoint("stair-bottom", ground(plan.hall_room_id), plan.expected_ground_eye_y);
    await moveTo(plan.points.stair_top, "north stair flight"); await checkpoint("stair-top", upper, plan.expected_upper_eye_y);
    await moveTo(plan.points.upper_clear, "upper landing"); await moveTo(plan.points.upper_room, "upper room");
    const upperEvidence = await checkpoint("upper-room", upper, plan.expected_upper_eye_y);
    report.checks.upper_floor_reached = upperEvidence.camera.y - initial.y > plan.stair.level - 0.35;
    assert.ok(report.checks.upper_floor_reached, "The actual camera did not ascend one saved storey");
    await moveTo(plan.points.upper_clear, "return upper landing"); await moveTo(plan.points.stair_top, "return stair top");
    await moveTo(plan.points.stair_bottom, "descend saved stair flight"); await checkpoint("returned-ground", ground(plan.hall_room_id), plan.expected_ground_eye_y);
    report.checks.stair_descent_completed = true;
    await moveTo(plan.points.hall, "return hall doorway"); await moveTo(plan.points.craft, "return partition doorway");
    await moveTo(plan.points.inside, "return exterior doorway"); await moveTo(plan.points.outside, "return outdoors");
    await checkpoint("returned-outdoors", null, plan.expected_ground_eye_y); report.checks.exterior_return_completed = true;
    await moveTo(plan.entrance, "return saved entrance"); const returned = await checkpoint("returned-entrance", null, plan.expected_ground_eye_y);
    report.checks.returned_to_entrance = distance(returned.camera, plan.entrance) < 0.3;
    assert.ok(report.checks.returned_to_entrance, "The actual walker did not return to the saved entrance");
    await navigate("orbit"); await page.waitForTimeout(500); const beforeResume = await get(walkPath);
    await navigate("walk"); await viewport.scrollIntoViewIfNeeded();
    const resumed = await checkpoint("restored-exterior-position", null, plan.expected_ground_eye_y);
    report.checks.saved_position_restored = distance(resumed.camera, beforeResume.pose.position) < 0.3
      && await viewport.getAttribute("data-pose-restore") === "restored";
    assert.ok(report.checks.saved_position_restored, "The actual app did not restore the saved exterior physics position");
    const finalScene = await readScene(); assert.equal(finalScene.revision, scene.revision); assert.equal(hash(finalScene.definition), report.scene.definition_sha256);
    report.checks.geometry_unchanged = true;
    const finalConnections = await get(connectionsPath);
    assert.equal(hash(finalConnections.network), coordinateFrame.network_sha256, "Saved connected frames or geometry changed during actual workshop walk");
    report.checks.connected_frames_unchanged = true; report.status = "passed";
    return report;
  } catch (error) {
    report.reason = error.message; report.status = "needs_review";
    if (viewport) { report.failure_camera = await observe().catch(() => lastObserved ?? null); await page.screenshot({ path: join(directory, `${run}-failure.png`), fullPage: false }).catch(() => {}); }
    return report;
  } finally {
    await release();
    if (viewport) await navigate("orbit").catch(() => {});
    const deadline = Date.now() + 6000; while (inFlight && Date.now() < deadline) await page.waitForTimeout(100);
    if (ownsAutosave) approvedUiWrites.delete(walkPath);
    if (report.status === "passed" && (saveErrors.length || inFlight)) { report.status = "needs_review"; report.reason = saveErrors[0] ?? "The app's final position acknowledgement remains pending"; }
    report.finished_at = new Date().toISOString(); await persist();
    await atomicJson(join(directory, "walk-result.json"), report);
    await log("walk_result", { status: report.status, reason: report.reason ?? null, checks: report.checks, generation_submissions: 0 });
  }
}
