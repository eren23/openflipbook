/** One continuous, ordinary keyboard tour of the saved four-place world.
 * Generation routes, pose setters, route handoffs and original pilot writes are forbidden.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect as baseExpect } from "@playwright/test";
import { normalizedPilotChunks, pilotConnectedSpace } from "./quality-pilot-connected-walk.mjs";
import { derivePilotWalkPlan, matchPilotWalkObservation, parsePilotWalkObservation, validatePilotWalkAutosave } from "./quality-pilot-walk.mjs";
import { pilotReviewHash } from "./quality-pilot-review-floor.mjs";

const expect = baseExpect.configure({ timeout: 60_000 });
const wrap = value => Math.atan2(Math.sin(value), Math.cos(value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const xml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);

export const longWalkChromiumOptions = platform => ({ headless: true, slowMo: 0, ...(platform === "darwin" ? { args: ["--use-angle=metal"] } : {}) });
export const longWalkDefinitionReceipt = definition => ({
  definition_sha256: createHash("sha256").update(JSON.stringify(definition), "utf8").digest("hex"),
  definition_sha256_algorithm: "sha256_utf8_json_stringify",
  canonical_definition_sha256: pilotReviewHash(definition),
  canonical_definition_sha256_algorithm: "sha256_utf8_recursive_sorted_json",
});
export function exportLongWalkSamples(observations) {
  const samples = [], coalesced = []; let group = null, previousIndex = -1;
  for (const [index, p] of observations.entries()) {
    assert.ok([p.elapsed_seconds, p.x, p.y, p.z, p.yaw, p.pitch].every(finite) && p.elapsed_seconds >= 0, "Route samples require finite recorded times and poses");
    const sample = { seconds: p.elapsed_seconds, position: [p.x, p.y, p.z], yaw: p.yaw, pitch: p.pitch, place_id: p.place_id };
    const previous = samples.at(-1);
    assert.ok(!previous || previous.seconds <= sample.seconds, "Recorded route observations must remain in time order");
    if (previous?.seconds === sample.seconds) {
      if (!group) { group = { seconds: sample.seconds, discarded: [], selected: null }; coalesced.push(group); }
      group.discarded.push({ observation_index: previousIndex, sample: previous });
      group.selected = { observation_index: index, sample };
      samples[samples.length - 1] = sample;
    } else { samples.push(sample); group = null; }
    previousIndex = index;
  }
  return { samples, provenance: { policy: "last_actual_observation_per_timestamp", input_observations: observations.length,
    exported_samples: samples.length, coalesced_observations: observations.length - samples.length, duplicate_timestamp_groups: coalesced.length,
    full_observations_file: "route-observations.json", coalesced,
    statement: "Each equal timestamp retains its final recorded pose; no timestamps or poses are invented. Full observations, walking-distance evidence and autosave guard history remain unchanged." } };
}
export function longWalkAxisCorrection(remaining) {
  assert.ok(finite(remaining));
  // Two axes each within .15m remain inside the unchanged .3m checkpoint.
  // A 120ms ordinary press moves at most .3m at the app's 2.5m/s speed.
  return Math.abs(remaining) <= 0.15 ? null : { key: remaining > 0 ? "w" : "s", delay_ms: 120 };
}

export function validateLongWalkEnvironment(receipt, environment) {
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, "long-walk-demo"); assert.equal(receipt.state, "running");
  assert.equal(receipt.providers_disabled, true, "Generation must be disabled on this independent clone");
  assert.equal(receipt.worker_disabled, true, "No generation worker may run during the free tour");
  const origin = new URL(receipt.origin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1"); assert.ok(origin.port);
  assert.equal(origin.username, ""); assert.equal(origin.password, ""); assert.equal(origin.pathname, "/");
  assert.equal(origin.search, ""); assert.equal(origin.hash, "");
  assert.equal(receipt.origin, origin.origin, "Use a canonical local origin without a trailing slash");
  assert.ok(safeId(receipt.world?.session_id) && safeId(receipt.world?.place_id), "Explicit saved world ownership is required");
  assert.equal(resolve(receipt.evidence_dir), dirname(resolve(environment)), "Use the new receipt's separate evidence directory");
  assert.ok(typeof receipt.browser_state_file === "string" && resolve(receipt.browser_state_file) === receipt.browser_state_file);
  return receipt;
}

const obstacleBox = (object, chunk) => {
  assert.ok([object.x, object.z, object.width, object.depth, object.heading].every(finite), "Unknown saved obstacle bounds");
  const c = Math.abs(Math.cos(object.heading)), s = Math.abs(Math.sin(object.heading));
  const w = (object.width * c + object.depth * s) / 2 + 0.35, d = (object.depth * c + object.width * s) / 2 + 0.35;
  return { x1: chunk.x + object.x - w, x2: chunk.x + object.x + w, z1: chunk.z + object.z - d, z2: chunk.z + object.z + d };
};
const intersects = (a, b, box) => Math.max(a.x, b.x) > box.x1 && Math.min(a.x, b.x) < box.x2
  && Math.max(a.z, b.z) > box.z1 && Math.min(a.z, b.z) < box.z2;

/** Explicit reviewed route, recomputed from the current saved geometry. Changed
 * dimensions, blocked lanes or unsupported doors stop before walking.
 */
export function deriveLongWalkPlan(network, world) {
  const chunks = normalizedPilotChunks(network, world.session_id);
  assert.equal(chunks.length, 4, "The long tour requires all four saved places");
  const root = chunks.find(c => c.scene.place_id === world.place_id); assert.ok(root);
  const find = label => { const found = chunks.filter(c => c.scene.definition.label === label); assert.equal(found.length, 1, `Missing unique ${label}`); return found[0]; };
  const west = find("Clockmakers Western Lane"), annex = find("Canal Garden Annex"), north = find("Contemporary Civic Garden");
  assert.equal(network.connections.length, 3, "The saved four-place graph must have three connections");
  const endpoint = (chunk, end) => {
    const d = chunk.scene.definition;
    assert.ok(["west", "east", "north", "south"].includes(end.side) && finite(end.offset));
    return { x: chunk.x + (end.side === "west" ? 0 : end.side === "east" ? d.width : end.offset),
      z: chunk.z + (end.side === "north" ? 0 : end.side === "south" ? d.depth : end.offset) };
  };
  const portals = {};
  for (const [name, chunk, side, opposite] of [["west", west, "west", "east"], ["annex", annex, "east", "west"], ["north", north, "north", "south"]]) {
    const links = network.connections.filter(c => [c.a, c.b].some(e => e.place_id === root.scene.place_id && e.side === side)
      && [c.a, c.b].some(e => e.place_id === chunk.scene.place_id && e.side === opposite));
    assert.equal(links.length, 1, `Missing ${name} boundary connection`);
    const link = links[0]; assert.equal(link.kind, "boundary"); assert.equal(link.version, 1); assert.ok(link.width >= 1.2);
    const end = [link.a, link.b].find(e => e.place_id === root.scene.place_id), other = [link.a, link.b].find(e => e.place_id === chunk.scene.place_id);
    const point = endpoint(root, end); assert.ok(distance(point, endpoint(chunk, other)) < 0.001, "Connection endpoints do not align");
    portals[name] = { ...point, connection_id: link.id, width: link.width, normal_axis: side === "north" ? "z" : "x", places: [root.scene.place_id, chunk.scene.place_id] };
  }
  const building = (chunk, label) => {
    const objects = chunk.scene.definition.objects.filter(o => o.kind === "building" && o.label === label); assert.equal(objects.length, 1, `Missing ${label}`);
    const o = objects[0], door = o.structure?.door;
    assert.ok(Math.abs(o.heading) < 1e-8 && !o.structure.footprint && door && !door.wall_id && door.floor === 0 && door.sill === 0 && door.width >= 1.1,
      `Unsupported saved doorway for ${label}`);
    assert.ok(o.structure.floors.length === 1 && (!o.structure.floors[0].layout || o.structure.floors[0].layout.type === "room"));
    return o;
  };
  const guild = building(west, "Clockmakers Guild"), lodge = building(west, "Workshop Lodge"), tea = building(annex, "Canal Tea House"), reading = building(north, "Civic Reading Hall");
  assert.equal(guild.structure.door.side, "south"); assert.equal(lodge.structure.door.side, "north");
  assert.equal(tea.structure.door.side, "south"); assert.equal(reading.structure.door.side, "south");
  const workshop = derivePilotWalkPlan(root.scene.definition); assert.ok(workshop.supported, workshop.reason);
  const points = [];
  const add = (chunk, x, z, label, options = {}) => {
    const p = { x: chunk.x + x, z: chunk.z + z, y: 1.6, place_id: chunk.scene.place_id, label, ...options };
    assert.ok(x >= 0.35 && x <= chunk.scene.definition.width - 0.35 && z >= 0.35 && z <= chunk.scene.definition.depth - 0.35, `${label} lies outside the saved place`);
    const space = pilotConnectedSpace(chunk.scene.definition, { x, z, y: p.y - 0.78 });
    p.space = space; points.push(p); return p;
  };
  const doorVisit = (chunk, o, prefix) => {
    const south = o.structure.door.side === "south", x = o.x + o.structure.door.offset;
    const edge = o.z + (south ? 1 : -1) * o.depth / 2;
    add(chunk, x, edge + (south ? 1.1 : -1.1), `${prefix}-outside`, { shell: o.id });
    add(chunk, x, edge + (south ? -1.5 : 1.5), `${prefix}-inside`, { shell: o.id, look: true });
    add(chunk, x, edge + (south ? 1.1 : -1.1), `${prefix}-exit`, { shell: o.id });
  };
  const re = root.scene.definition.entrance;
  add(root, re.x, re.z, "root-entrance");
  add(root, 4, re.z, "root-west-south-lane"); add(root, 4, portals.west.z - root.z, "root-west-gate");
  add(west, west.scene.definition.width - 1, portals.west.z - west.z, "west-handoff");
  add(west, guild.x + guild.structure.door.offset, portals.west.z - west.z, "west-guild-lane");
  doorVisit(west, guild, "clockmakers-guild");
  add(west, lodge.x + lodge.structure.door.offset, portals.west.z - west.z, "west-lodge-lane"); doorVisit(west, lodge, "workshop-lodge");
  add(west, lodge.x + lodge.structure.door.offset, portals.west.z - west.z, "west-middle-lane");
  add(west, 11, portals.west.z - west.z, "west-south-turn"); add(west, 11, west.scene.definition.entrance.z, "west-south-walk");
  add(west, west.scene.definition.entrance.x, west.scene.definition.entrance.z, "west-entrance", { look: true });
  add(west, 11, west.scene.definition.entrance.z, "west-return-turn"); add(west, 11, portals.west.z - west.z, "west-return-lane");
  add(west, west.scene.definition.width - 1, portals.west.z - west.z, "west-return-gate");
  add(root, 4, portals.west.z - root.z, "root-west-return"); add(root, 4, 30, "root-south-street-west");
  add(root, workshop.points.outside.x, 30, "workshop-approach-turn");
  const workshopPoint = (name, label, upper = false, look = false) => { const p = workshop.points[name]; add(root, p.x, p.z, label,
    { shell: workshop.building_id, y: upper ? workshop.expected_upper_eye_y : 1.6, look }); };
  workshopPoint("outside", "workshop-outside"); workshopPoint("inside", "workshop-ground-craft", false, true);
  workshopPoint("craft", "workshop-partition-approach"); workshopPoint("hall", "workshop-ground-hall", false, true);
  workshopPoint("stair_bottom", "workshop-stair-bottom"); workshopPoint("stair_top", "workshop-stair-top", true);
  workshopPoint("upper_clear", "workshop-upper-landing", true); workshopPoint("upper_room", "workshop-upper-studio", true, true);
  workshopPoint("upper_clear", "workshop-return-landing", true); workshopPoint("stair_top", "workshop-return-stair-top", true);
  workshopPoint("stair_bottom", "workshop-return-ground"); workshopPoint("hall", "workshop-return-hall"); workshopPoint("craft", "workshop-return-craft");
  workshopPoint("inside", "workshop-return-door"); workshopPoint("outside", "workshop-exit");
  add(root, workshop.points.outside.x, re.z, "root-south-walk"); add(root, 36, re.z, "root-east-south-turn");
  add(root, 36, portals.annex.z - root.z, "root-east-gate"); add(annex, 1, portals.annex.z - annex.z, "annex-handoff");
  add(annex, tea.x + tea.structure.door.offset, portals.annex.z - annex.z, "annex-promenade"); doorVisit(annex, tea, "canal-tea-house");
  add(annex, tea.x + tea.structure.door.offset, portals.annex.z - annex.z, "annex-return-promenade"); add(annex, 1, portals.annex.z - annex.z, "annex-return-gate");
  add(root, 36, portals.annex.z - root.z, "root-east-return"); add(root, 36, 5, "root-north-east-lane");
  add(root, portals.north.x - root.x, 5, "root-north-gate-approach"); add(root, portals.north.x - root.x, 1, "root-north-gate");
  add(north, portals.north.x - north.x, north.scene.definition.depth - 1, "north-handoff");
  add(north, reading.x + reading.structure.door.offset, 20, "civic-hall-promenade"); doorVisit(north, reading, "civic-reading-hall");
  add(north, reading.x + reading.structure.door.offset, 35, "civic-garden-south"); add(north, 6, 35, "civic-garden-west", { look: true });
  add(north, 36, 35, "civic-garden-east"); add(north, 36, 5, "civic-garden-north-east");
  add(north, 10, 5, "civic-garden-north-west", { look: true }); add(north, 10, 20, "civic-garden-west-forecourt");
  add(north, portals.north.x - north.x, 20, "civic-return-promenade"); add(north, portals.north.x - north.x, north.scene.definition.depth - 1, "north-return-gate");
  add(root, portals.north.x - root.x, 1, "root-north-return"); add(root, portals.north.x - root.x, 14, "root-garden-lane");
  add(root, 16, 14, "root-workshop-west-lane"); add(root, 16, re.z, "root-return-south-lane"); add(root, re.x, re.z, "root-returned-entrance", { look: true });
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], corner = { ...a, x: b.x };
    const segments = [a, corner, b];
    length += Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    for (let j = 1; j < segments.length; j++) for (const chunk of chunks) for (const o of chunk.scene.definition.objects) {
      if (o.kind === "path") continue;
      if (o.placement) {
        const floor = a.space?.floor_id ?? b.space?.floor_id;
        if (o.placement.floor_id !== floor) continue;
        const host = chunk.scene.definition.objects.find(item => item.id === o.placement.building_id); assert.ok(host && Math.abs(host.heading) < 1e-8);
        assert.ok(!intersects(segments[j - 1], segments[j], obstacleBox({ ...o, x: host.x + o.x, z: host.z + o.z }, chunk)), `Interior ${o.label} blocks ${b.label}`);
        continue;
      }
      if (o.kind === "building" && (a.shell === o.id || b.shell === o.id)) continue;
      assert.ok(!intersects(segments[j - 1], segments[j], obstacleBox(o, chunk)), `Saved ${o.label} blocks ${b.label}`);
    }
  }
  assert.ok(length >= 400, "The extended saved route must cover at least 400 authored metres");
  return { version: 1, chunks, portals, points, planned_metres: length, expected_places: chunks.map(c => c.scene.place_id),
    workshop, network_sha256: pilotReviewHash(network), controls: "Pointer yaw and ordinary W/S keyboard only; no synthetic camera or pose changes" };
}

export function longWalkOverview(plan, observations = []) {
  const width = Math.max(...plan.chunks.map(c => c.x + c.scene.definition.width));
  const depth = Math.max(...plan.chunks.map(c => c.z + c.scene.definition.depth));
  const polyline = points => points.map(p => `${p.x},${p.z}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -6 ${width + 8} ${depth + 12}" width="1000" height="1000"><rect x="-4" y="-6" width="${width + 8}" height="${depth + 12}" fill="#f6f2e8"/><style>text{font-family:system-ui;font-size:1.6px}.label{font-weight:600}.building{fill:#c9b69a;stroke:#796d59;stroke-width:.15}</style>${plan.chunks.map(c => `<g><rect x="${c.x}" y="${c.z}" width="${c.scene.definition.width}" height="${c.scene.definition.depth}" fill="#dce6cd" stroke="#7c8d71" stroke-width=".3"/><text class="label" x="${c.x + 1}" y="${c.z + 2.5}">${xml(c.scene.definition.label)}</text>${c.scene.definition.objects.filter(o => o.kind === "building").map(o => `<g transform="translate(${c.x + o.x} ${c.z + o.z}) rotate(${o.heading * 180 / Math.PI})"><rect class="building" x="${-o.width / 2}" y="${-o.depth / 2}" width="${o.width}" height="${o.depth}"/><text text-anchor="middle" y="0">${xml(o.label)}</text></g>`).join("")}</g>`).join("")}<polyline points="${polyline(plan.points)}" fill="none" stroke="#bd9135" stroke-width=".4" stroke-dasharray="1,1"/><polyline points="${polyline(observations)}" fill="none" stroke="#2477b8" stroke-width=".5"/>${observations.length ? `<circle cx="${observations.at(-1).x}" cy="${observations.at(-1).z}" r=".8" fill="#a32337"/>` : ""}<text x="0" y="${depth + 4}">Gold: planned route (${plan.planned_metres.toFixed(1)} m). Blue: observed physics camera; no generated positions.</text></svg>`;
}

export function longWalkBoundaryProof(plan, observations) {
  return Object.fromEntries(Object.entries(plan.portals).map(([name, portal]) => {
    const crossings = observations.slice(1).flatMap((after, index) => {
      const before = observations[index];
      if (before.place_id === after.place_id || !portal.places.includes(before.place_id) || !portal.places.includes(after.place_id)) return [];
      assert.ok(distance(before, portal) <= portal.width / 2 + 1 && distance(after, portal) <= portal.width / 2 + 1,
        "An observed place transition occurred away from its saved boundary opening");
      return [{ before, after }];
    });
    return [name, { connection_id: portal.connection_id, crossings, forward_and_return: crossings.length >= 2
      && crossings.some(c => c.before.place_id === portal.places[0]) && crossings.some(c => c.after.place_id === portal.places[0]) }];
  }));
}

/** A genuine position save can be queued on the first frame past a portal,
 * between two CDP samples. Adjacent-place history remains the same physical
 * global camera: accept it only in the exact saved opening, within the existing
 * .55m seam distance. All ordinary history/time/yaw/space guards still run.
 */
export function validateLongWalkAutosave(body, plan, observations) {
  const chunk = plan.chunks.find(c => c.scene.place_id === body?.pose?.place_id); assert.ok(chunk, "Autosave belongs to an unknown place");
  const position = body.pose.position; assert.ok(position && [position.x, position.y, position.z].every(finite));
  const global = { x: position.x + chunk.x, z: position.z + chunk.z };
  const eligible = observations.filter(sample => {
    if (sample.place_id === chunk.scene.place_id) return true;
    return Object.values(plan.portals).some(portal => {
      if (!portal.places.includes(chunk.scene.place_id) || !portal.places.includes(sample.place_id)) return false;
      const normal = portal.normal_axis, tangent = normal === "x" ? "z" : "x";
      return Math.abs(global[normal] - portal[normal]) <= 0.55 && Math.abs(sample[normal] - portal[normal]) <= 0.55
        && Math.abs(global[tangent] - portal[tangent]) <= portal.width / 2 && Math.abs(sample[tangent] - portal[tangent]) <= portal.width / 2;
    });
  }).map(sample => ({ ...sample, x: sample.x - chunk.x, z: sample.z - chunk.z, observed_place_id: sample.place_id }));
  const pose = validatePilotWalkAutosave(body, { place_id: chunk.scene.place_id }, chunk.scene, eligible);
  assert.deepEqual(pose.space, pilotConnectedSpace(chunk.scene.definition, position), "Autosave room differs from current saved geometry");
  const matched = matchPilotWalkObservation(pose, eligible); assert.ok(matched);
  return { pose, chunk, matched_local_camera: matched, cross_boundary_history: matched.observed_place_id !== chunk.scene.place_id };
}

/** Only the observed, empty root-west corridor may resume a stopped tour. The
 * saved position is physically walked back to the entrance, never reset.
 */
export function deriveLongWalkRecovery(plan, observed) {
  const entrance = plan.points[0], root = plan.chunks.find(c => c.scene.place_id === entrance.place_id);
  assert.equal(observed.place_id, root.scene.place_id, "Physical recovery only supports the known root-west corridor");
  assert.ok(Math.abs(observed.y - 1.6) < 0.35, "Physical recovery requires the measured exterior ground height");
  if (distance(observed, entrance) < 0.35) return [];
  assert.ok(observed.x >= root.x + 2 && observed.x <= root.x + 5 && observed.z >= root.z + 15 && observed.z <= root.z + 21,
    "Saved start is outside the checked root-west recovery corridor; no reset is allowed");
  const points = [{ x: root.x + 4, z: observed.z, label: "recovery-west-lane" },
    { x: root.x + 4, z: plan.portals.west.z, label: "recovery-west-gate" },
    { x: root.x + 4, z: entrance.z, label: "recovery-south-lane" }, { x: entrance.x, z: entrance.z, label: "recovery-entrance" }]
    .map(p => ({ ...p, place_id: root.scene.place_id, y: 1.6, space: null }));
  for (const [index, end] of points.entries()) {
    const start = index ? points[index - 1] : observed;
    for (const chunk of plan.chunks) for (const object of chunk.scene.definition.objects) {
      if (object.kind === "path" || object.placement) continue;
      assert.ok(!intersects(start, end, obstacleBox(object, chunk)), `Saved ${object.label} blocks the physical recovery lane`);
    }
  }
  return points;
}

export function mergeLongWalkObservations(report, raw, plan, started) {
  const parsed = raw.map(a => {
    assert.equal(a.mode, "walk"); assert.equal(Number(a.loaded_places), 4); assert.ok(plan.expected_places.includes(a.place_id));
    assert.ok(finite(a.observed_at)); const camera = parsePilotWalkObservation(a.camera, a.yaw);
    const direction = a.direction?.split(",").map(Number);
    assert.ok(direction?.length === 3 && direction.every(finite) && Math.abs(Math.hypot(...direction) - 1) < 0.001,
      "The actual rendered camera has no unit direction measurement");
    assert.ok(Math.abs(wrap(Math.atan2(-direction[0], -direction[2]) - camera.yaw)) < 0.005, "Rendered camera direction and yaw disagree");
    return { ...camera, pitch: Math.atan2(direction[1], Math.hypot(direction[0], direction[2])), direction,
      pitch_provenance: "rendered_camera_direction_attribute", place_id: a.place_id,
      observed_at: a.observed_at, elapsed_seconds: (a.observed_at - started) / 1000 };
  });
  const key = p => `${p.observed_at}:${p.place_id}:${p.x}:${p.y}:${p.z}:${p.yaw}`;
  const known = new Set(report.observations.map(key));
  for (const p of parsed) if (!known.has(key(p))) { report.observations.push(p); known.add(key(p)); }
  report.observations.sort((a, b) => a.observed_at - b.observed_at);
  return parsed.at(-1);
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file); await chmod(file, 0o600);
}
async function privateFile(file) { const info = await lstat(file); assert.ok(info.isFile() && !(info.mode & 0o077), "Owner state and environment must be private (0600)"); return JSON.parse(await readFile(file, "utf8")); }

export async function runLongKeyboardWalk({ page, receipt, directory, approvedUiWrites, get, readNetwork, save = atomicJson, log = async () => {} }) {
  const started = Date.now(), walkPath = `/api/creator/worlds/${receipt.world.session_id}/walk`;
  const report = { version: 1, status: "needs_review", started_at: new Date(started).toISOString(), generation_submissions: 0,
    controls: "Ordinary W/S keyboard and pointer yaw in one uninterrupted app Walk view", observations: [], checkpoints: [], movement: [], autosaves: [], rejected_autosaves: [], checks: {} };
  const before = await readNetwork(), plan = deriveLongWalkPlan(before, receipt.world); report.plan = plan;
  await save(join(directory, "route-plan.json"), plan); await writeFile(join(directory, "route-overview-planned.svg"), longWalkOverview(plan), { flag: "wx", mode: 0o600 });
  const errors = []; let last, viewport, inFlight = 0, persistence = Promise.resolve();
  const persist = () => { persistence = persistence.then(() => save(join(directory, "long-walk-evidence.json"), report)); return persistence; };
  const observe = async () => {
    if (errors.length) throw new Error(errors[0]);
    const samples = await viewport.evaluate(el => {
      const tracker = window.__ofbLongWalkPassiveHistory;
      const buffered = tracker?.element === el ? tracker.samples.splice(0) : [];
      buffered.push({ mode: el.dataset.mode, camera: el.dataset.camera, yaw: el.dataset.yaw, direction: el.dataset.direction,
        place_id: el.dataset.placeId, loaded_places: el.dataset.loadedPlaces, observed_at: Date.now() });
      return buffered;
    });
    last = mergeLongWalkObservations(report, samples, plan, started); return last;
  };
  const release = async () => { for (const key of ["w", "a", "s", "d"]) await page.keyboard.up(key).catch(() => {}); };
  const map = async label => {
    await page.getByRole("button", { name: "World map", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "World map", exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("connected-world-map")).toBeVisible();
    await page.screenshot({ path: join(directory, `${label}.png`) }); await chmod(join(directory, `${label}.png`), 0o600);
    await page.getByRole("button", { name: "Close world map", exact: true }).click(); await expect(dialog).not.toBeVisible();
    if (viewport) await viewport.locator("canvas").click({ position: { x: 40, y: 40 } });
  };
  const align = async yaw => {
    for (let attempt = 0; attempt < 24; attempt++) {
      const beforeYaw = await observe(), delta = wrap(beforeYaw.yaw - yaw); if (Math.abs(delta) < 0.003) return;
      const box = await viewport.locator("canvas").boundingBox(); assert.ok(box?.width > 150 && box.height > 150);
      const max = Math.min(120, box.width * 0.25), dx = Math.max(-max, Math.min(max, delta / 0.005));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      try { await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 }); } finally { await page.mouse.up(); }
      await page.waitForTimeout(100); report.movement.push({ control: "pointer-yaw", before: beforeYaw, after: await observe() });
    }
    throw new Error("Ordinary pointer yaw failed to converge");
  };
  const axis = async (name, target, label) => {
    const start = await observe(), delta = target - start[name]; if (!longWalkAxisCorrection(delta)) return;
    const sign = Math.sign(delta), yaw = name === "x" ? sign > 0 ? -Math.PI / 2 : Math.PI / 2 : sign > 0 ? Math.PI : 0;
    await align(yaw); let lastProgress = await observe(), movedAt = Date.now(); const deadline = Date.now() + Math.max(25_000, Math.abs(delta) * 6000);
    const progress = after => {
      if (Math.abs(after[name] - lastProgress[name]) > 0.01) { movedAt = Date.now(); lastProgress = after; }
      assert.ok(Date.now() - movedAt < 5000, `Actual capsule blocked during ${label}`); assert.ok(Date.now() < deadline, `Actual movement timed out during ${label}`);
      assert.ok(Date.now() - started < 15 * 60_000, "The continuous tour exceeded its bounded run duration");
    };
    // Hold the actual forward key through open lanes, then release .4m from
    // the target and measure bounded ordinary corrections near doorways.
    if (Math.abs(delta) > 0.4) {
      const before = await observe(); await page.keyboard.down("w");
      try {
        for (;;) { await page.waitForTimeout(90); const after = await observe(); progress(after); if (sign * (target - after[name]) <= 0.4) break; }
      } finally { await page.keyboard.up("w"); }
      await page.waitForTimeout(70); const after = await observe(); movedAt = Date.now(); lastProgress = after;
      report.movement.push({ label, control: "keyboard-held", key: "w", before, after });
    }
    for (;;) {
      const current = await observe(), remaining = sign * (target - current[name]), correction = longWalkAxisCorrection(remaining); if (!correction) break;
      const key = correction.key, delay = correction.delay_ms;
      await page.keyboard.press(key, { delay }); await page.waitForTimeout(70);
      const after = await observe(); report.movement.push({ label, control: "keyboard", key, delay_ms: delay, before: current, after });
      progress(after);
    }
  };
  const checkpoint = async point => {
    await release(); await page.waitForTimeout(800); const camera = await observe();
    assert.equal(camera.place_id, point.place_id, `${point.label} is in another place`); assert.ok(distance(camera, point) < 0.3);
    assert.ok(Math.abs(camera.y - point.y) < 0.35, `${point.label} eye height differs from its saved floor`);
    const chunk = plan.chunks.find(c => c.scene.place_id === point.place_id), deadline = Date.now() + 12_000;
    let saved;
    for (;;) {
      saved = await get(walkPath); const pose = saved.pose;
      if (pose?.place_id === camera.place_id && pose.scene_revision === chunk.scene.revision
        && distance({ x: pose.position.x + chunk.x, z: pose.position.z + chunk.z }, camera) < 0.25
        && Math.abs(pose.position.y + 0.78 - camera.y) < 0.3 && pilotReviewHash(pose.space) === pilotReviewHash(point.space)) break;
      assert.ok(Date.now() < deadline, `${point.label} has no acknowledged actual position / room`); await page.waitForTimeout(300); await observe();
    }
    const screenshot = `${String(report.checkpoints.length).padStart(2, "0")}-${point.label}.png`; await page.screenshot({ path: join(directory, screenshot) }); await chmod(join(directory, screenshot), 0o600);
    const room = page.getByRole("status", { name: "Current room", exact: true });
    report.checkpoints.push({ label: point.label, camera, saved, room_text: await room.count() ? await room.textContent() : null, screenshot });
    await persist(); await log("long_walk_checkpoint", { label: point.label, camera, space: saved.pose.space });
    if (["clockmakers-guild-inside", "workshop-upper-studio", "canal-tea-house-inside", "civic-reading-hall-inside"].includes(point.label)) await map(`world-map-${point.label}`);
    if (point.look) { const yaw = camera.yaw; await align(wrap(yaw + Math.PI / 3)); await page.waitForTimeout(1500); await observe(); await align(wrap(yaw - Math.PI / 3)); await page.waitForTimeout(1500); await observe(); await align(yaw); }
  };
  assert.ok(!approvedUiWrites.has(walkPath));
  approvedUiWrites.set(walkPath, async (route, body) => {
    inFlight++;
    try {
      assert.equal(route.request().method(), "POST"); assert.equal(new URL(route.request().url()).pathname, walkPath);
      if (viewport && await viewport.count()) await observe(); assert.ok(last);
      const checked = validateLongWalkAutosave(body, plan, report.observations);
      const response = await route.fetch({ maxRedirects: 0 }), text = await response.text(), saved = JSON.parse(text);
      assert.ok(response.ok(), `Actual app autosave failed (${response.status()})`); assert.equal(saved.revision, body.base_revision + 1); assert.deepEqual(saved.pose, body.pose);
      report.autosaves.push({ input_sha256: pilotReviewHash(body), request_id: body.request_id, observed: last, matched_local_camera: checked.matched_local_camera,
        cross_boundary_history: checked.cross_boundary_history, saved });
      await route.fulfill({ response, body: text }); await persist();
    } catch (error) { errors.push(error.message); report.rejected_autosaves.push({ reason: error.message, body, observed: last }); await persist(); await route.abort().catch(() => {}); }
    finally { inFlight--; }
  });
  try {
    await map("world-map-before"); await page.getByRole("button", { name: "Walk", exact: true }).click();
    viewport = page.locator('[data-testid="place-viewport"][data-mode="walk"]').first(); await expect(viewport).toHaveAttribute("data-ready", "true");
    report.rendering = { platform: process.platform, chromium_launch: longWalkChromiumOptions(process.platform),
      ...await viewport.locator("canvas").evaluate(canvas => {
        const gl = canvas.getContext("webgl2");
        if (!gl) return { context: null, limitation: "Existing canvas exposes no WebGL2 context" };
        const extension = gl.getExtension("WEBGL_debug_renderer_info");
        return { context: "webgl2", vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
          unmasked_vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
          unmasked_renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null };
      }) };
    // Read-only instrumentation observes the app's completed frame attributes.
    // It changes no DOM, input, scene, pose, camera or application state. The
    // browser records intermediate genuine frames even while CDP is stalled.
    await viewport.evaluate(el => {
      window.__ofbLongWalkPassiveHistory?.observer.disconnect();
      const tracker = { element: el, samples: [], last: null, observer: null };
      const record = () => {
        if (el.dataset.mode !== "walk") return;
        const value = { mode: el.dataset.mode, camera: el.dataset.camera, yaw: el.dataset.yaw, direction: el.dataset.direction,
          place_id: el.dataset.placeId, loaded_places: el.dataset.loadedPlaces, observed_at: Date.now() };
        const key = `${value.camera}:${value.yaw}:${value.direction}:${value.place_id}`;
        if (key === tracker.last) return;
        tracker.last = key; tracker.samples.push(value);
        tracker.samples = tracker.samples.filter(s => value.observed_at - s.observed_at <= 10_000).slice(-1000);
      };
      tracker.observer = new MutationObserver(record);
      tracker.observer.observe(el, { attributes: true, attributeFilter: ["data-camera", "data-yaw", "data-direction", "data-place-id"] });
      window.__ofbLongWalkPassiveHistory = tracker; record();
    });
    await viewport.scrollIntoViewIfNeeded(); await viewport.locator("canvas").click({ position: { x: 40, y: 40 } });
    const initial = await observe(); report.initial = initial;
    const recovery = deriveLongWalkRecovery(plan, initial); report.physical_recovery = recovery;
    for (const point of recovery) { await axis("x", point.x, point.label); await axis("z", point.z, point.label); await checkpoint(point); }
    for (const point of plan.points) { await axis("x", point.x, point.label); await axis("z", point.z, point.label); await checkpoint(point); }
    await map("world-map-after"); await observe();
    const after = await readNetwork(); assert.equal(pilotReviewHash(after), plan.network_sha256, "Saved geometry / connections changed during the tour");
    report.actual_metres = report.observations.slice(1).reduce((sum, p, i) => sum + distance(report.observations[i], p), 0);
    report.boundary_proof = longWalkBoundaryProof(plan, report.observations);
    const visited = new Set(report.checkpoints.map(p => p.camera.place_id));
    report.checks = { all_four_places_visited: visited.size === 4, all_three_boundaries_crossed_and_returned: Object.values(report.boundary_proof).every(p => p.forward_and_return),
      at_least_two_interiors: new Set(report.checkpoints.map(p => p.saved.pose.space?.building_id).filter(Boolean)).size >= 2,
      workshop_upstairs: report.checkpoints.some(p => p.label === "workshop-upper-studio" && p.saved.pose.space?.floor_id === plan.workshop.upper_floor_id),
      physical_return_to_root_entrance: distance(last, plan.points[0]) < 0.3 && last.place_id === receipt.world.place_id,
      at_least_400_metres: report.actual_metres >= 400, geometry_and_connections_unchanged: true, no_rejected_autosaves: !errors.length };
    assert.ok(Object.values(report.checks).every(Boolean), "The actual continuous tour is incomplete"); report.status = "passed";
  } catch (error) { report.reason = error.message; await release(); await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {}); }
  finally {
    await release(); if (viewport) await page.getByRole("button", { name: "3D", exact: true }).click().catch(() => {});
    const deadline = Date.now() + 6000; while (inFlight && Date.now() < deadline) await page.waitForTimeout(100);
    await page.evaluate(() => { window.__ofbLongWalkPassiveHistory?.observer.disconnect(); delete window.__ofbLongWalkPassiveHistory; }).catch(() => {});
    approvedUiWrites.delete(walkPath); if (errors.length || inFlight) { report.status = "needs_review"; report.reason = errors[0] ?? "Final app autosave remains pending"; }
    report.finished_at = new Date().toISOString(); report.duration_seconds = (Date.now() - started) / 1000;
    await persist(); await writeFile(join(directory, "route-overview-observed.svg"), longWalkOverview(plan, report.observations), { flag: "wx", mode: 0o600 });
    await save(join(directory, "route-observations.json"), { version: 1, coordinate_frame: "normalized_network_metres", network_sha256: plan.network_sha256,
      origins: plan.chunks.map(c => ({ place_id: c.scene.place_id, x: c.x, z: c.z, revision: c.scene.revision })), observations: report.observations, provider_submissions: 0 });
    let glbSha = null;
    if (receipt.world_glb_file) {
      assert.equal(resolve(receipt.world_glb_file), receipt.world_glb_file, "Pin an ordinary absolute exported GLB file");
      const info = await lstat(receipt.world_glb_file); assert.ok(info.isFile());
      glbSha = createHash("sha256").update(await readFile(receipt.world_glb_file)).digest("hex");
    }
    const exported = exportLongWalkSamples(report.observations);
    await save(join(directory, "walk-route.json"), { version: 1, coordinate_system: "right_handed_y_up", units: "authored_metres", glb_sha256: glbSha,
      samples: exported.samples, sample_export: exported.provenance,
      source: { network_sha256: plan.network_sha256, time_origin: "walk_started_at", started_at: report.started_at,
        pitch_provenance: "Actual rendered camera direction attribute, atan2(direction.y,hypot(direction.x,direction.z)); no assumed zero pitch",
        places: plan.chunks.map(c => ({ place_id: c.scene.place_id, scene_id: c.scene.id, revision: c.scene.revision,
          ...longWalkDefinitionReceipt(c.scene.definition), normalized_origin: { x: c.x, z: c.z } })) },
      limitations: "Recorded camera observations, with no inferred positions between samples. Seconds start at the walk evidence run; the uncut browser video includes its earlier page-loading prelude.", provider_submissions: 0 });
  }
  return report;
}

export async function executeLongWalk(environment) {
  const path = resolve(environment), receipt = validateLongWalkEnvironment(await privateFile(path), path), state = await privateFile(receipt.browser_state_file);
  const directory = join(receipt.evidence_dir, `long-walk-${Date.now()}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { mode: 0o700 });
  const lock = join(receipt.evidence_dir, ".long-walk.lock"); await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("Another continuous tour is active"); });
  let browser, context, page, result; const rejected = [], errors = [];
  try {
    browser = await chromium.launch(longWalkChromiumOptions(process.platform));
    context = await browser.newContext({ baseURL: receipt.origin, storageState: state, serviceWorkers: "block", viewport: { width: 1280, height: 900 },
      recordVideo: { dir: directory, size: { width: 1280, height: 900 } } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); page = await context.newPage(); page.setDefaultTimeout(60_000);
    page.on("pageerror", error => errors.push(error.message)); const approvedUiWrites = new Map();
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()); if (["GET", "HEAD"].includes(request.method())) return route.continue();
      const handler = approvedUiWrites.get(url.pathname);
      if (url.origin !== receipt.origin || request.method() !== "POST" || !handler) { rejected.push({ method: request.method(), path: url.pathname }); return route.abort("blockedbyclient"); }
      await handler(route, request.postDataJSON());
    });
    const base = `/api/world/${receipt.world.session_id}/places/${receipt.world.place_id}`, walk = `/api/creator/worlds/${receipt.world.session_id}/walk`;
    const get = async p => { assert.ok(p === `${base}/connections` || p === walk || /^\/api\/world\/[A-Za-z0-9_-]+\/places\/[A-Za-z0-9_-]+\/(scene|build)$/.test(p));
      const response = await page.request.get(`${receipt.origin}${p}`, { maxRedirects: 0 }); assert.ok(response.ok(), `Owned read failed (${response.status()})`); return response.json(); };
    const readNetwork = async () => { const value = await get(`${base}/connections`); assert.ok(value.network); return value.network; };
    await page.goto(`/sketch/world?${new URLSearchParams({ world: receipt.world.session_id, place: receipt.world.place_id, view: "orbit" })}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="place-viewport"][data-mode="orbit"]').first()).toHaveAttribute("data-ready", "true");
    const before = await readNetwork(); await atomicJson(join(directory, "network-before.json"), before);
    const readJobs = async () => {
      const values = await Promise.allSettled(before.chunks.map(async c => ({ place_id: c.scene.place_id,
        jobs: await get(`/api/world/${receipt.world.session_id}/places/${c.scene.place_id}/build`) })));
      for (const value of values) assert.equal(value.status, "fulfilled", value.reason?.message); return values.map(value => value.value);
    };
    const jobsBefore = await readJobs(); await atomicJson(join(directory, "jobs-before.json"), jobsBefore);
    result = await runLongKeyboardWalk({ page, receipt, directory, approvedUiWrites, get, readNetwork,
      log: async (event, detail) => console.log(JSON.stringify({ event, ...detail })) });
    const after = await readNetwork(), jobsAfter = await readJobs(); await atomicJson(join(directory, "network-after.json"), after); await atomicJson(join(directory, "jobs-after.json"), jobsAfter);
    assert.equal(pilotReviewHash(before), pilotReviewHash(after)); assert.equal(pilotReviewHash(jobsBefore), pilotReviewHash(jobsAfter), "Build jobs changed during the free tour");
    result.browser_errors = errors; result.blocked_writes = rejected;
    if (errors.length || rejected.length) { result.status = "needs_review"; result.reason = "Browser errors or unapproved writes occurred"; }
  } catch (error) {
    result ??= { version: 1, status: "needs_review", generation_submissions: 0 };
    result.status = "needs_review"; result.reason = error.message;
    if (page) await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
  } finally {
    if (context) { await context.tracing.stop({ path: join(directory, "trace.zip") }).catch(() => {}); await context.close(); }
    if (page && result) {
      const video = await page.video().path(); await chmod(video, 0o600); const bytes = await readFile(video);
      result.video = { file: video, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, uncut: true };
      await atomicJson(join(directory, "long-walk-evidence.json"), result);
    }
    await browser?.close(); await rm(lock, { recursive: true });
  }
  console.log(JSON.stringify({ status: result.status, directory, actual_metres: result.actual_metres, duration_seconds: result.duration_seconds, video: result.video, reason: result.reason ?? null }));
  if (result.status !== "passed") process.exitCode = 1; return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { environment: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("quality-pilot-long-walk.mjs --environment <new private long-walk-demo receipt>\nFree continuous keyboard tour; only verified app walk autosaves may write to the independent clone.");
  else { assert.ok(values.environment, "--environment is required"); await executeLongWalk(values.environment); }
}
