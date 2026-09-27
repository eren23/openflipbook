/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, any>>(), owner: true, fail: "" }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function collection(name: string) {
  const matches = (d: any, q: any) => Object.entries(q).every(([k, v]: any) => v && typeof v === "object" && "$in" in v ? v.$in.includes(d[k]) : d[k] === v);
  const find = (q: any) => [...store(name).values()].filter(d => matches(d, q));
  return {
    findOne: async (q: any) => structuredClone(find(q)[0] ?? null),
    find: (q: any) => { const c = { sort: () => c, limit: () => c, toArray: async () => structuredClone(find(q)) }; return c; },
    insertOne: async (d: any) => { if (memory.fail === name) throw new Error("write failure"); if (store(name).has(d._id)) throw new Error("duplicate"); store(name).set(d._id, structuredClone(d)); },
    replaceOne: async (_q: any, d: any) => { store(name).set(d._id, structuredClone(d)); return { matchedCount: 1 }; },
    updateOne: async (q: any, update: any) => { for (const d of find(q).slice(0, 1)) Object.assign(d, update.$set); },
    updateMany: async (q: any, update: any) => { for (const d of find(q)) Object.assign(d, update.$set); },
  };
}
vi.mock("./db", () => ({ getDb: async () => ({ collection }), withDbTransaction: async (run: any) => { const before = structuredClone(memory.rows); try { return await run({ collection }, {}); } catch (e) { memory.rows = before; throw e; } } }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw Object.assign(new Error("Not owner"), { status: 403 }); return { collection }; } }));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: async () => "owner-token" }));
import { emptyPlaceScene, gardenScene, newComponent } from "./place-scene";
import { ankhStreetScene } from "./ankh-scene";
import { alignedDrumScene } from "./drum-alignment";
import { deleteEntity, getWorldState, pinEntity, renameEntity } from "./world";
import { updatePlace } from "./places";
import { applyLegacySceneEdits, applyPlaceScene, createPlaceWorld, previewAdjacentPlace, previewPlaceScene, readPlaceScene, savedPlaceContext, sceneContext } from "./place-scene-server";
import { readPlaceNetwork } from "./place-connections-store";
import { connectionInputHash } from "./place-build-connections";
import { mapObject } from "./map-artwork";
import { POST as createWorldPOST } from "@/app/api/creator/worlds/route";
beforeEach(() => { memory.rows.clear(); memory.owner = true; memory.fail = ""; store("nodes").set("root", { _id: "root", session_id: "world", image_key: "original.png" }); });
afterEach(() => vi.unstubAllEnvs());
const preview = (definition = gardenScene(), revision = 0) => previewPlaceScene("world", "garden", { definition, base_revision: revision, source_node_id: "root" });
const createInput = () => {
  vi.stubEnv("MONGODB_URI", "mongodb://test"); vi.stubEnv("MONGODB_DB", "test");
  return { request_id: crypto.randomUUID(), definition: { ...emptyPlaceScene(), objects: [newComponent("building", 20, 20)] } };
};
async function alignmentFixture() {
  const definition = { ...emptyPlaceScene(), objects: [{ ...newComponent("building", 10, 12), id: "inn", label: "Inn" }] };
  const first = await preview(definition); const saved = await applyPlaceScene("world", "garden", first.proposal.id);
  const frame = { width: 1600, height: 900 }, registration = { x: 50, y: 50, width: 60, rotation: 12 };
  const p = mapObject({ ...definition.objects[0]!, x: 14, z: 18 }, definition, registration, frame);
  store("map_alignment_drafts").set("world:garden", { _id: "world:garden", session_id: "world", place_id: "garden", scene_id: saved.scene.id, scene_revision: 1, scene_source_node_id: "root", map_node_id: "root", revision: 1, frame, registration, landmarks: [{ object_id: "inn", x: p.cx / frame.width * 100, y: p.cy / frame.height * 100 }], updated_at: new Date(0) });
  return { saved, input: { base_revision: 1, map_alignment: { revision: 1, object_ids: ["inn"], confirmed_projection: true } } };
}
it("derives a landmark correction from the saved draft, previews before applying, and replays Apply idempotently", async () => {
  const { saved, input } = await alignmentFixture();
  const result = await previewPlaceScene("world", "garden", { ...input, definition: { forged: true } });
  expect((await readPlaceScene("world", "garden")).scene).toEqual(saved.scene);
  expect(result.proposal.changes.join(" ")).toContain("approximate ground-plane");
  const applied = await applyPlaceScene("world", "garden", result.proposal.id);
  expect(applied.scene.revision).toBe(2); expect(applied.scene.definition.objects[0]!.x).toBeCloseTo(14);
  expect(applied.scene.definition.objects[0]!.structure).toEqual(saved.scene.definition.objects[0]!.structure);
  expect(store("world_edit_proposals").get(result.proposal.id).alignment_source.draft.landmarks).toHaveLength(1);
  expect(store("map_artwork_versions").size).toBe(0); expect(store("map_artwork_heads").size).toBe(0);
  expect(await applyPlaceScene("world", "garden", result.proposal.id)).toEqual(applied);
});
it.each(["draft", "artwork", "geometry"])("rejects changed %s after alignment preview without partial writes", async reason => {
  const { input } = await alignmentFixture();
  const result = await previewPlaceScene("world", "garden", input);
  if (reason === "draft") store("map_alignment_drafts").get("world:garden").revision++;
  if (reason === "artwork") store("map_artwork_heads").set("world:root", { _id: "world:root", node_id: "replacement" });
  if (reason === "geometry") store("place_scenes").get("world:garden").revision++;
  const before = structuredClone(memory.rows);
  await expect(applyPlaceScene("world", "garden", result.proposal.id)).rejects.toMatchObject({ status: 409 });
  expect(memory.rows).toEqual(before);
});
it("requires an owned current draft and explicit projection review", async () => {
  const { input } = await alignmentFixture();
  await expect(previewPlaceScene("world", "garden", { ...input, map_alignment: { ...input.map_alignment, confirmed_projection: false } })).rejects.toMatchObject({ status: 400 });
  await expect(previewPlaceScene("world", "garden", { ...input, map_alignment: { ...input.map_alignment, revision: 0 } })).rejects.toMatchObject({ status: 409 });
  memory.owner = false;
  await expect(previewPlaceScene("world", "garden", input)).rejects.toMatchObject({ status: 403 });
});
it("creates a source-free owned world atomically, with real entity identities and no image nodes", async () => {
  const input = createInput(), result = await createPlaceWorld(input);
  const sid = result.session_id;
  expect(result.scene).toMatchObject({ revision: 1, source_node_id: null, source_image_key: null, definition: input.definition });
  expect(store("session_owners").get(sid).owner_token).toBe("owner-token");
  expect(store("creator_worlds").get(sid)).toMatchObject({ resume_place_id: result.place_id, visibility: "private" });
  expect(store("nodes").size).toBe(1);
  expect(store("world_state").get(sid).entities).toHaveLength(2);
  for (const e of store("world_state").get(sid).entities) expect(e).toMatchObject({ first_seen_node_id: null, last_seen_node_id: null, appears_on_node_ids: [] });
  expect(await savedPlaceContext(sid, result.place_id)).toMatchObject({ source_url: null, source_node_id: null, versions: [], initial: input.definition });
  const next = structuredClone(input.definition); next.objects[0]!.structure!.door.offset = 1;
  const p = await previewPlaceScene(sid, result.place_id, { base_revision: 1, definition: next, source_node_id: "foreign-injected-source" });
  expect(p.proposal.affected_node_ids).toEqual([]);
  await applyPlaceScene(sid, result.place_id, p.proposal.id);
  expect((await readPlaceScene(sid, result.place_id)).scene).toMatchObject({ revision: 2, source_node_id: null, definition: next });
});
it("retains generated origins through preview edits, later revisions and history without trusting client receipts", async () => {
  const first = await createPlaceWorld(createInput()), sid = first.session_id, pid = first.place_id;
  const bench = newComponent("bench", 6, 6), definition = { ...first.scene.definition, objects: [...first.scene.definition.objects, bench] };
  const receipt = { job_id: "generated", model: "test-model", request_id: "provider", prompt: "A bench", base_revision: 1, input_sha256: "input-hash", object_ids: [bench.id], reserved_usd: 0.2, created_at: "2026-09-12" };
  store("place_build_jobs").set(`${sid}:${pid}:generated`, { _id: `${sid}:${pid}:generated`, status: "ready", base_revision: 1, receipt });
  const p = await previewPlaceScene(sid, pid, { base_revision: 1, definition, generation_job_id: "generated" });
  expect(p.proposal.generation_job_id).toBe("generated");
  const second = await applyPlaceScene(sid, pid, p.proposal.id); expect(second.scene.generation_sources).toEqual([receipt]);
  expect(store("world_state").get(sid).entities.find((e: any) => e.id === bench.entity_id).facts[0]).toContain("AI-proposed");
  const next = { ...definition, label: "Renamed place" };
  const manual = await previewPlaceScene(sid, pid, { base_revision: 2, definition: next, generation_sources: [{ model: "forged" }] });
  expect((await applyPlaceScene(sid, pid, manual.proposal.id)).scene.generation_sources).toEqual([receipt]);
  expect((await readPlaceScene(sid, pid)).history.filter(s => s.revision > 1).every(s => s.generation_sources?.[0]?.request_id === "provider")).toBe(true);
  await expect(previewPlaceScene(sid, pid, { base_revision: 3, definition, generation_job_id: "generated" })).rejects.toMatchObject({ status: 409 });
  await expect(previewPlaceScene(sid, pid, { base_revision: 3, definition, generation_job_id: "foreign" })).rejects.toMatchObject({ status: 409 });
});
it("previews and atomically connects a new place without revising the existing scene",async()=>{
  const first=await createPlaceWorld(createInput()),before=structuredClone(first.scene);
  const p=await previewAdjacentPlace(first.session_id,first.place_id,{side:"east",width:3,source_revision:1,definition:{...emptyPlaceScene(),label:"Next square"}});
  expect(store("place_connections").size).toBe(0);expect(store("place_scenes").size).toBe(1);
  const next=await applyPlaceScene(first.session_id,p.place_id,p.proposal.id);
  expect(next.proposal.connection).toEqual(p.proposal.connection);expect(store("place_connections").size).toBe(1);
  expect((await readPlaceScene(first.session_id,first.place_id)).scene).toEqual(before);
  const network=await readPlaceNetwork(first.session_id,first.place_id);
  expect(network?.chunks).toHaveLength(2);expect(network?.chunks.find(c=>c.scene.place_id===p.place_id)?.x).toBe(40);
  await applyPlaceScene(first.session_id,p.place_id,p.proposal.id);
  expect(store("place_connections").size).toBe(1);expect(store("place_scene_versions").size).toBe(2);
  await expect(previewPlaceScene(first.session_id,first.place_id,{base_revision:1,definition:{...before.definition,width:60}})).rejects.toThrow("align");
  const blocked={...before.definition,objects:[...before.definition.objects,{...newComponent("wall",39.8,20),width:4,depth:0.3,heading:Math.PI/2}]};
  await expect(previewPlaceScene(first.session_id,first.place_id,{base_revision:1,definition:blocked})).rejects.toThrow("blocked");
});
it("rechecks frozen generation connections inside Apply when preview saw newer world metadata", async () => {
  const first = await createPlaceWorld(createInput()), sid = first.session_id, pid = first.place_id;
  const connection_input = { version: 1 as const, place_id: pid, connections: [] };
  const bench = newComponent("bench", 6, 6), definition = { ...first.scene.definition, objects: [...first.scene.definition.objects, bench] };
  const receipt = { job_id: "generated", model: "test-model", request_id: "provider", prompt: "A bench", base_revision: 1, input_sha256: "input-hash", object_ids: [bench.id], reserved_usd: 0.2, created_at: "2026-09-13", connection_input, connections_sha256: connectionInputHash(connection_input) };
  const next = await previewAdjacentPlace(sid, pid, { side: "east", width: 3, source_revision: 1, definition: emptyPlaceScene() });
  await applyPlaceScene(sid, next.place_id, next.proposal.id);
  // Simulate a link committed after the build precheck but before preview reads
  // world metadata: the ordinary world hash is current, the build input is not.
  const preview = await previewPlaceScene(sid, pid, { base_revision: 1, definition }, undefined, receipt);
  const before = structuredClone(memory.rows);
  await expect(applyPlaceScene(sid, pid, preview.proposal.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("connections changed") });
  expect(memory.rows).toEqual(before); expect((await readPlaceScene(sid, pid)).scene!.revision).toBe(1);
});
it("rolls back the adjoining scene on connection write failure and rejects stale source revisions",async()=>{
  const first=await createPlaceWorld(createInput());
  const input={side:"west",width:3,source_revision:1,definition:emptyPlaceScene()};
  await expect(previewAdjacentPlace(first.session_id,first.place_id,{...input,source_revision:2})).rejects.toMatchObject({status:409});
  const p=await previewAdjacentPlace(first.session_id,first.place_id,input);memory.fail="place_connections";
  await expect(applyPlaceScene(first.session_id,p.place_id,p.proposal.id)).rejects.toThrow("write failure");
  expect(store("place_scenes").size).toBe(1);expect(store("place_scene_versions").size).toBe(1);
  memory.fail="";await applyPlaceScene(first.session_id,p.place_id,p.proposal.id);
  memory.owner=false;await expect(readPlaceNetwork(first.session_id,first.place_id)).rejects.toMatchObject({status:403});
});
it("replays a lost creation response without another world, history entry or overwrite", async () => {
  const input = createInput(), first = await createPlaceWorld(input);
  expect(await createPlaceWorld(input)).toEqual(first);
  const next = { ...input.definition, label: "Changed after creation" };
  const p = await previewPlaceScene(first.session_id, first.place_id, { base_revision: 1, definition: next });
  await applyPlaceScene(first.session_id, first.place_id, p.proposal.id);
  expect((await createPlaceWorld(input)).scene).toMatchObject({ revision: 2, definition: next });
  expect(store("session_owners").size).toBe(1); expect(store("place_scene_versions").size).toBe(2);
  await expect(createPlaceWorld({ ...input, definition: next })).rejects.toMatchObject({ status: 409 });
  store("session_owners").get(first.session_id).owner_token = "someone-else";
  await expect(createPlaceWorld(input)).rejects.toMatchObject({ status: 403 });
});
it("resizing a source-free root preserves authored metre scale and absolute object positions", async () => {
  const input = createInput(), first = await createPlaceWorld(input);
  const next = { ...input.definition, width: 80, depth: 80 };
  const p = await previewPlaceScene(first.session_id, first.place_id, { base_revision: 1, definition: next });
  await applyPlaceScene(first.session_id, first.place_id, p.proposal.id);
  const map = store("world_map").get(first.session_id), root = map.entities.find((e: any) => e.id === first.place_id);
  const object = map.entities.find((e: any) => e.id === input.definition.objects[0]!.id);
  expect(root).toMatchObject({ scale: 1, footprint: { w: 80, d: 80 }, pos: { x: 40, y: 40 } });
  expect(root.pos.x + object.pos.x).toBe(20); expect(root.pos.y + object.pos.y).toBe(20);
});
it("rolls back new ownership and metadata together with failed scene creation", async () => {
  const input = createInput(); memory.fail = "place_scene_versions";
  await expect(createPlaceWorld(input)).rejects.toThrow("write failure");
  for (const name of ["session_owners", "creator_worlds", "world_map", "world_state", "world_edit_proposals", "place_scenes"]) expect(store(name).size).toBe(0);
  memory.fail = "";
  expect((await createPlaceWorld(input)).scene.revision).toBe(1);
});
it("does not claim an existing unowned world or import a foreign mesh through creation", async () => {
  const input = createInput();
  store("nodes").set("legacy", { _id: "legacy", session_id: `session_${input.request_id}` });
  await expect(createPlaceWorld(input)).rejects.toMatchObject({ status: 409 });
  const mesh = { ...newComponent("mesh", 20, 20), asset_id: "foreign" };
  await expect(createPlaceWorld({ ...createInput(), definition: { ...emptyPlaceScene(), objects: [mesh] } })).rejects.toMatchObject({ status: 400 });
  expect(store("session_owners").size).toBe(0);
});
it("validates new-world route bodies, origin, persistence and feature flag before writes", async () => {
  const input = createInput();
  // happy-dom strips forbidden browser headers from constructed Requests.
  const post = (body: string, origin = "http://local") => createWorldPOST({ url: "http://local/api/creator/worlds", headers: new Headers({ origin, "content-type": "application/json" }), text: async () => body } as Request);
  expect((await post("null")).status).toBe(400);
  expect((await post("{")).status).toBe(400);
  expect((await post("x".repeat(150001))).status).toBe(413);
  expect((await post(JSON.stringify(input), "http://foreign")).status).toBe(403);
  await expect(createPlaceWorld({ ...input, request_id: "not-uuid" })).rejects.toMatchObject({ status: 400 });
  vi.stubEnv("MONGODB_URI", ""); await expect(createPlaceWorld(input)).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "0"); await expect(createPlaceWorld(input)).rejects.toMatchObject({ status: 404 });
  expect(store("session_owners").size).toBe(0);
});
it("persists structured floors and openings through edits, reload and restoration", async () => {
  const definition={...gardenScene(),version:2 as const,objects:[newComponent("building",10,10)]};
  const p=await preview(definition);const first=(await applyPlaceScene("world","garden",p.proposal.id)).scene;
  expect(first.definition).toEqual(definition);
  const next=structuredClone(definition);next.objects[0]!.structure!.door.offset=1.2;
  const p2=await preview(next,1);await applyPlaceScene("world","garden",p2.proposal.id);
  expect((await readPlaceScene("world","garden")).scene?.definition).toEqual(next);
  expect(store("world_map").get("world").entities.find((o:any)=>o.id===next.objects[0]!.id)).toMatchObject({kind:"place",entity_id:next.objects[0]!.entity_id});
  const restore=await preview(first.definition,2);await applyPlaceScene("world","garden",restore.proposal.id);
  expect((await readPlaceScene("world","garden")).scene?.definition).toEqual(definition);
  expect(store("nodes").get("root").image_key).toBe("original.png");
});
it("requires a world-owned generated asset and retains its binding through apply", async () => {
  const definition = {...gardenScene(), objects: [{...newComponent("mesh", 5, 5), asset_id: "mesh_test"}]};
  await expect(preview(definition)).rejects.toMatchObject({status:403});
  store("mesh_assets").set("world:mesh_test", {_id:"world:mesh_test", session_id:"world"});
  const p = await preview(definition);
  const saved = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  expect(saved.definition.objects[0]!.asset_id).toBe("mesh_test");
  expect(store("world_map").get("world").entities.find((o:any)=>o.id===definition.objects[0]!.id)).toMatchObject({height:3,footprint:{w:3,d:3}});
});
it.each([false, true])("requires owned materials and rejects stale appearance changes without changing geometry (ground=%s)", async ground => {
  const first = await createPlaceWorld(createInput()), sid = first.session_id, pid = first.place_id;
  const binding = { asset_id: "material_test", tile_metres: 2, rotation: 0, roughness: 0.85 };
  const definition = ground ? { ...first.scene.definition, ground_material: binding } : { ...first.scene.definition, objects: first.scene.definition.objects.map(o => ({ ...o, materials: { wall: binding } })) };
  const input = { definition, base_revision: 1 };
  store("material_assets").set(`other:${binding.asset_id}`, { _id: `other:${binding.asset_id}`, session_id: "other" });
  await expect(previewPlaceScene(sid, pid, input)).rejects.toMatchObject({ status: 403 });
  expect((await readPlaceScene(sid, pid)).scene).toEqual(first.scene);
  store("material_assets").set(`${sid}:${binding.asset_id}`, { _id: `${sid}:${binding.asset_id}`, session_id: sid });
  const a = await previewPlaceScene(sid, pid, input), b = await previewPlaceScene(sid, pid, input);
  const saved = (await applyPlaceScene(sid, pid, a.proposal.id)).scene;
  expect(saved.definition).toEqual(definition);
  const { materials, ...geometry } = saved.definition.objects[0]!;
  expect(materials).toEqual(ground ? undefined : { wall: binding });
  expect(geometry).toEqual(first.scene.definition.objects[0]);
  await expect(applyPlaceScene(sid, pid, b.proposal.id)).rejects.toMatchObject({ status: 409 });
  expect((await readPlaceScene(sid, pid)).scene).toEqual(saved);
  const undo = await previewPlaceScene(sid, pid, { definition: first.scene.definition, base_revision: 2 });
  expect((await applyPlaceScene(sid, pid, undo.proposal.id)).scene.definition).toEqual(first.scene.definition);
});
it("requires saving a world before attaching generated surface materials", async () => {
  const input = createInput();
  const definition = { ...input.definition, objects: input.definition.objects.map(o => ({ ...o, materials: { roof: { asset_id: "foreign", tile_metres: 2, rotation: 0, roughness: 1 } } })) };
  await expect(createPlaceWorld({ ...input, definition })).rejects.toMatchObject({ status: 400 });
  expect(store("session_owners").size).toBe(0);
  expect(store("place_scenes").size).toBe(0);
});
it.each([false, true])("validates locked mesh proportions with source correction %s and keeps map dimensions aligned", async corrected => {
  const object = { ...newComponent("mesh", 5, 5), width: 1.5, height: corrected ? 2.25 : 3, depth: corrected ? 3 : 2.25, ...(corrected ? { mesh_orientation: { x: 1, y: 0, z: 0 } } : {}), mesh_scale: "uniform" as const, asset_id: "mesh_test" };
  const definition = { ...gardenScene(), objects: [object] };
  store("mesh_assets").set("world:mesh_test", { _id: "world:mesh_test", session_id: "world", sha256: "verified", geometry: { sha256: "verified", size: { width: 2, height: 4, depth: 3 } } });
  await expect(preview({ ...definition, objects: [{ ...object, width: 3 }] })).rejects.toMatchObject({ status: 400 });
  expect(store("world_edit_proposals").size).toBe(0);
  const p = await preview(definition); const saved = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  expect(saved.definition.objects[0]).toEqual(object);
  expect(store("world_map").get("world").entities.find((o: { id: string }) => o.id === object.id)).toMatchObject({ height: object.height, footprint: { w: object.width, d: object.depth } });
  const stretch = await preview({ ...definition, objects: [{ ...object, width: 3, mesh_scale: "stretch" }] }, 1);
  await applyPlaceScene("world", "garden", stretch.proposal.id);
  expect((await readPlaceScene("world", "garden")).scene?.definition.objects[0]).toMatchObject({ width: 3, mesh_scale: "stretch" });
});
it("persists floor-local furnishings and interprets legacy moves in the map frame", async () => {
  const building = newComponent("building", 10, 10);
  building.height = 7.8; building.heading = Math.PI / 2;
  building.structure!.floors.push({ id: "upper", label: "Upper room" });
  const bench = { ...newComponent("bench", 0, 0), placement: { building_id: building.id, floor_id: "upper" } };
  const definition = { ...gardenScene(), version: 2 as const, objects: [building, bench] };
  const p = await preview(definition), first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  const moved = await applyLegacySceneEdits("world", first.id, [{ op: "move", target: bench.id, dx: 0, dy: 1 }]);
  expect(moved.scene.definition.objects[1]).toMatchObject({ x: 1, z: expect.closeTo(0), placement: bench.placement });
  expect((await readPlaceScene("world", "garden")).scene?.definition).toEqual(moved.scene.definition);
  expect(store("world_map").get("world").entities.find((o: { id: string }) => o.id === bench.id)).toMatchObject({ parent_id: building.id, floor_id: "upper", elevation: 3.2, pos: { x: expect.closeTo(0), y: 1 } });
  await expect(applyLegacySceneEdits("world", first.id, [{ op: "remove", target: building.id }])).rejects.toMatchObject({ status: 400 });
  expect((await readPlaceScene("world", "garden")).scene?.revision).toBe(2);
});
it("persists the street template and its edits in canonical world history", async () => {
  const definition = ankhStreetScene(), p = await preview(definition);
  const first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  expect(first.definition).toEqual(definition);
  const tavern = definition.objects.find(o => o.kind === "tavern")!;
  const next = structuredClone(definition); next.objects.find(o => o.id === tavern.id)!.color = "#884455";
  const p2 = await preview(next, 1); await applyPlaceScene("world", "garden", p2.proposal.id);
  const read = await readPlaceScene("world", "garden");
  expect(read.scene?.definition.objects.find(o => o.id === tavern.id)).toMatchObject({ color: "#884455", x: 13, z: 15.7 });
  expect(read.history).toHaveLength(2);
  expect(store("world_map").get("world").entities.find((o: any) => o.id === tavern.id).visual).toBe("#884455 tavern");
  expect(store("nodes").get("root").image_key).toBe("original.png");
});
it("preview does not change canonical world data", async () => {
  const result = await preview(); expect(result.proposal.changes).toContain("Create Garden");
  expect(store("world_map").size).toBe(0); expect(store("place_scenes").size).toBe(0);
});
it("retains fitted geometry and roof materials through preview, apply and history", async () => {
  const definition = alignedDrumScene(ankhStreetScene(), "shape_fit").definition;
  definition.material_pack = "ankh-street-v1";
  definition.objects.find(o => o.kind === "tavern")!.roof_material = "teal";
  const p = await preview(definition);
  expect(store("place_scenes").size).toBe(0);
  const first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  expect(first.definition).toEqual(definition);
  const next = structuredClone(definition); next.objects.find(o => o.kind === "tavern")!.roof_material = "terracotta";
  const p2 = await preview(next, 1);
  expect(p2.proposal.changes).toContain("The Mended Drum roof: terracotta");
  await applyPlaceScene("world", "garden", p2.proposal.id);
  const read = await readPlaceScene("world", "garden");
  expect(read.scene?.definition).toEqual(next);
  expect(read.history.find(h => h.revision === 1)?.definition).toEqual(definition);
});
it("finds the same scene through chained image edits without replacing its reference", async () => {
  const p = await preview(); await applyPlaceScene("world", "garden", p.proposal.id);
  store("nodes").set("edit1", { _id: "edit1", parent_id: "root", relation: "edit", session_id: "world", image_key: "edit.png" });
  store("nodes").set("edit2", { _id: "edit2", parent_id: "edit1", relation: "edit", session_id: "world", image_key: "edit2.png" });
  const context = await sceneContext("edit2");
  expect(context).toMatchObject({ place_id: "garden", source_node_id: "root", requested_source_node_id: "edit2", requested_source_url: "/api/image/edit2" });
  expect(context.scene?.source_image_key).toBe("original.png");
  expect(context.versions.map(v => v.id)).toEqual(["root", "edit1", "edit2"]);
  expect(store("place_scenes").size).toBe(1);
  const changed = structuredClone(context.scene!.definition); changed.label = "Updated garden";
  const p2 = await preview(changed, 1);
  expect(p2.proposal.affected_node_ids).toEqual(["root", "edit1", "edit2"]);
  await applyPlaceScene("world", "garden", p2.proposal.id);
  expect(store("nodes").get("edit2").scene_outdated).toBe(true);
});
it("does not follow descent edges, cross-world parents or cyclic edit chains", async () => {
  const p = await preview(); await applyPlaceScene("world", "garden", p.proposal.id);
  store("nodes").set("child", { _id: "child", parent_id: "root", relation: "descend", session_id: "world" });
  expect((await sceneContext("child")).scene).toBeNull();
  await expect(sceneContext("child", "garden")).rejects.toMatchObject({ status: 409 });
  store("nodes").get("child").relation = "edit";
  store("nodes").get("root").session_id = "other";
  expect((await sceneContext("child")).scene).toBeNull();
  store("nodes").get("child").parent_id = "child";
  expect((await sceneContext("child")).scene).toBeNull();
  memory.owner = false;
  await expect(sceneContext("child")).rejects.toMatchObject({ status: 403 });
});
it("applies a frozen proposal atomically and replay never reapplies it", async () => {
  const p = await preview(), applied = await applyPlaceScene("world", "garden", p.proposal.id);
  expect(applied.scene.revision).toBe(1); expect(store("world_map").get("world").entities).toHaveLength(11);
  expect(store("world_state").get("world").entities).toHaveLength(11);
  expect((await getWorldState("world")).entities).toHaveLength(11);
  expect(store("nodes").get("root")).toMatchObject({ image_key: "original.png", scene_outdated: true });
  expect((await applyPlaceScene("world", "garden", p.proposal.id)).scene).toEqual(applied.scene);
  expect(store("place_scene_versions").size).toBe(1);
});
it("moves and paints the same entities and retains historical revisions", async () => {
  const p = await preview(), first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  const next = structuredClone(first.definition); next.objects[1]!.x = 15; next.objects[2]!.color = "#a54962";
  const p2 = await preview(next, 1); const second = (await applyPlaceScene("world", "garden", p2.proposal.id)).scene;
  expect(second.revision).toBe(2); expect(second.definition.objects.map(o => o.id)).toEqual(first.definition.objects.map(o => o.id));
  const read = await readPlaceScene("world", "garden"); expect(read.history).toHaveLength(2);
  const undo = await preview(first.definition, 2); expect((await applyPlaceScene("world", "garden", undo.proposal.id)).scene).toMatchObject({ revision: 3, definition: first.definition });
});
it("rejects stale preview revisions and changes made after preview", async () => {
  await expect(preview(gardenScene(), 5)).rejects.toMatchObject({ status: 409 });
  const p = await preview(); store("world_map").set("world", { _id: "world", entities: [], updated_at: new Date() });
  await expect(applyPlaceScene("world", "garden", p.proposal.id)).rejects.toMatchObject({ status: 409 });
});
it("only one competing creation proposal can become current", async () => {
  const a = await preview(), b = await preview(); await applyPlaceScene("world", "garden", a.proposal.id);
  await expect(applyPlaceScene("world", "garden", b.proposal.id)).rejects.toMatchObject({ status: 409 });
});
it("rolls back entity, map and scene writes on a history failure", async () => {
  const p = await preview(); memory.fail = "place_scene_versions";
  await expect(applyPlaceScene("world", "garden", p.proposal.id)).rejects.toThrow("write failure");
  expect(store("world_map").size).toBe(0); expect(store("world_state").size).toBe(0); expect(store("place_scenes").size).toBe(0);
  expect(store("world_edit_proposals").get(p.proposal.id).applied_revision).toBeUndefined();
});
it("owner gates cover reads, preview and even an already-applied receipt", async () => {
  const p = await preview(); await applyPlaceScene("world", "garden", p.proposal.id); memory.owner = false;
  await expect(readPlaceScene("world", "garden")).rejects.toMatchObject({ status: 403 });
  await expect(preview()).rejects.toMatchObject({ status: 403 });
  await expect(applyPlaceScene("world", "garden", p.proposal.id)).rejects.toMatchObject({ status: 403 });
});
it("rejects cross-world sources and foreign geometry bindings", async () => {
  store("nodes").get("root").session_id = "other"; await expect(preview()).rejects.toMatchObject({ status: 404 });
  store("nodes").get("root").session_id = "world";
  const d = gardenScene(); store("world_map").set("world", { _id: "world", entities: [{ id: d.objects[0]!.id, scene_id: "foreign" }], updated_at: new Date() });
  await expect(preview(d)).rejects.toMatchObject({ status: 409 });
});
it("returns a source-linked context and keeps legacy worlds image-only until Apply", async () => {
  store("nodes").get("root").page_title = "Lantern Quay";
  const result = await sceneContext("root", "garden"); expect(result.scene).toBeNull(); expect(result.initial.objects).toEqual([]);
  expect(result.initial).toMatchObject({ version: 2, label: "Lantern Quay", units: "authored_metres" });
  expect(result.source_url).toBe("/api/image/root"); expect(store("world_map").size).toBe(0);
});
it("keeps saved geometry when reopening a source and uses a bounded source title only for new places", async () => {
  const proposal = await preview(); const saved = (await applyPlaceScene("world", "garden", proposal.proposal.id)).scene;
  expect((await sceneContext("root", "garden")).initial).toEqual(saved.definition);
  store("nodes").get("root").page_title = "X".repeat(300);
  expect((await sceneContext("root", "new-place")).initial.label).toHaveLength(160);
  store("nodes").get("root").page_title = "  ";
  expect((await sceneContext("root", "new-place")).initial.label).toBe("New place");
});
it("deletes only removed scene objects and preserves unrelated entities", async () => {
  const p = await preview(); const first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  store("world_state").get("world").entities.push({ id: "unrelated", appears_on_node_ids: [] });
  const next = structuredClone(first.definition), removed = next.objects.shift()!;
  const p2 = await preview(next, 1); await applyPlaceScene("world", "garden", p2.proposal.id);
  const ids = store("world_state").get("world").entities.filter((e: any) => !e.deleted_at).map((e: any) => e.id);
  expect(ids).toContain("unrelated"); expect(ids).not.toContain(removed.entity_id);
  const restore = await preview(first.definition, 2); await applyPlaceScene("world", "garden", restore.proposal.id);
  expect(store("world_state").get("world").entities.find((e: any) => e.id === removed.entity_id).deleted_at).toBeNull();
});
it("legacy move and height edits share the scene commit and cannot write ambiguous materials", async () => {
  const p = await preview(); const first = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  const bench = first.definition.objects.find(o => o.kind === "bench")!;
  const moved = await applyLegacySceneEdits("world", first.id, [{ op: "move", target: bench.id, dx: 1, dy: 0 }, { op: "set_height", target: bench.id, height: 1 }]);
  expect(moved.scene.revision).toBe(2); expect(moved.scene.definition.objects.find(o => o.id === bench.id)).toMatchObject({ x: 15, height: 1 });
  await expect(applyLegacySceneEdits("world", first.id, [{ op: "set_appearance", target: bench.id, visual: "Gold" }])).rejects.toMatchObject({ status: 409 });
  await expect(applyLegacySceneEdits("world", first.id, [{ op: "add", label: "Unknown", pos: { x: 1, y: 1 } }])).rejects.toMatchObject({ status: 409 });
  await expect(applyLegacySceneEdits("world", first.id, [{ op: "remove", target: "other" }])).rejects.toMatchObject({ status: 409 });
  await applyLegacySceneEdits("world", first.id, [{ op: "remove", target: bench.id }]);
  expect((await readPlaceScene("world", "garden")).scene?.definition.objects.some(o => o.id === bench.id)).toBe(false);
});
it("place-inspector renames advance the same scene history", async () => {
  const p = await preview(); await applyPlaceScene("world", "garden", p.proposal.id);
  const parent = store("world_map").get("world").entities.find((g: any) => g.id === "garden");
  await updatePlace("world", "garden", { expected_updated_at: parent.updated_at, label: "Courtyard" });
  expect((await readPlaceScene("world", "garden")).scene).toMatchObject({ revision: 2, definition: { label: "Courtyard" } });
});
it("Codex cannot silently detach a scene object's identity", async () => {
  const p = await preview(); const scene = (await applyPlaceScene("world", "garden", p.proposal.id)).scene;
  const id = scene.definition.objects[0]!.entity_id;
  await expect(deleteEntity("world", id)).rejects.toThrow("World editor");
  await expect(renameEntity("world", id, "Elsewhere", null)).rejects.toThrow("World editor");
  await expect(pinEntity("world", id, false)).rejects.toThrow("World editor");
});
