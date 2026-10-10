import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import type { PlaceSceneSnapshot, WorldEntityGeo } from "@openflipbook/config";
const state = vi.hoisted(() => ({ rows: new Map<string, Document[]>(), files: new Map<string, Buffer>(), allowed: true, tail: Promise.resolve(),
  onRead: null as (() => void) | null, failInsert: null as string | null }));
const table = (name: string) => { if (!state.rows.has(name)) state.rows.set(name, []); return state.rows.get(name)!; };
const match = (r: Document, q: Document) => Object.entries(q).every(([k, v]) => r[k] === v);
const db = { collection: (name: string) => ({
  find: (q: Document) => { const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(table(name).filter(r => match(r, q))) }; return cursor; },
  findOne: async (q: Document) => structuredClone(table(name).find(r => match(r, q)) ?? null),
  countDocuments: async (q: Document) => table(name).filter(r => match(r, q)).length,
  insertOne: async (r: Document) => { if (state.failInsert === name) throw new Error("write failed"); table(name).push(structuredClone(r)); },
  updateOne: async (q: Document, change: Document) => { const row = table(name).find(r => match(r, q)); if (row) Object.assign(row, change.$set); return { matchedCount: row ? 1 : 0 }; },
}) };
vi.mock("./db", () => ({ getDb: async () => db, withDbTransaction: async (run: (db: unknown, session: object) => Promise<unknown>) => {
  const old = state.tail; let release!: () => void; state.tail = new Promise<void>(r => { release = r; }); await old;
  const backup = structuredClone(state.rows);
  try { return await run(db, {}); } catch (error) { state.rows = backup; throw error; } finally { release(); }
} }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!state.allowed) throw new Error("forbidden"); return db; } }));
vi.mock("./r2", () => ({ getStoredBytes: async (key: string) => { const before = state.onRead; state.onRead = null; before?.();
  return state.files.has(key) ? { bytes: state.files.get(key)!, contentType: "image/png" } : null; },
  uploadJpeg: async (key: string, bytes: Buffer) => { state.files.set(key, bytes); return { key }; } }));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: async () => "new-owner" }));
import { createPublication, forkPublication, publicationChoices, publicationFile, publicationLibrary, publicationLibraryFile, publicationZip, readPublication, selectPublication, unpublishWorld } from "./world-publication";
import JSZip from "jszip";
import { sceneGeos } from "./place-scene";
import { placeNetwork } from "./place-connections";
import { publicationGeometry, publicationPlaceNetwork } from "./world-publication-geometry";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const file = { key: "private/render", sha256: sha(Buffer.from("image")), bytes: 5 };
const definition = { version: 1, label: "City", width: 80, depth: 80, units: "authored_metres", objects: [], entrance: { x: 1, z: 1, yaw: 0 } };
beforeEach(() => { state.rows.clear(); state.files.clear(); state.allowed = true; state.tail = Promise.resolve(); state.onRead = null; state.failInsert = null; state.files.set(file.key, Buffer.from("image"));
  table("place_scenes").push({ _id: "private:city", id: "scene_city", session_id: "private", place_id: "city", revision: 1, definition: structuredClone(definition), source_image_key: "do-not-share", generation_sources: [{ prompt: "secret prompt" }] });
  table("place_views").push({ _id: "private:view", session_id: "private", id: "view", label: "Street", mode: "orbit", floor_id: null,
    sources: [{ place_id: "city", revision: 1, definition_sha256: sha(Buffer.from(JSON.stringify(definition))) }], files: { render: file }, request_sha256: "secret" });
  table("creator_notes").push({ session_id: "private", text: "private notes" });
});
const input = async () => ({ id: "public1", title: "Shared city", confirmed: true, source_sha256: (await publicationChoices("private")).source_sha256, place_ids: ["city"], view_ids: ["view"], path_ids: [] });
it("publishes only selected immutable content and does not grant access to the workspace", async () => {
  const request = await input(); await createPublication("private", request);
  const published = await readPublication("public1"), json = JSON.stringify(published);
  for (const secret of ["private", "source_image_key", "generation_sources", "secret", "prompt", "notes", "owner_token", "request_sha256"]) expect(json).not.toContain(secret);
  table("place_scenes")[0]!.definition.label = "Changed";
  expect((await readPublication("public1")).scenes[0]!.definition.label).toBe("City");
  expect((await publicationFile("public1", "view_view")).bytes.toString()).toBe("image");
  await expect(publicationFile("public1", "private_render")).rejects.toMatchObject({ status: 404 });
  expect(table("creator_worlds")).toEqual([]);
});
it("requires a fresh explicit selection and keeps acknowledgment retries immutable", async () => {
  const request = await input();
  await expect(createPublication("private", { ...request, confirmed: false })).rejects.toMatchObject({ status: 400 });
  table("place_scenes")[0]!.revision = 2;
  await expect(createPublication("private", request)).rejects.toMatchObject({ status: 409 });
  const fresh = await input(); await Promise.all([createPublication("private", fresh), createPublication("private", fresh)]);
  expect(table("world_publications")).toHaveLength(1);
  await expect(createPublication("private", { ...fresh, title: "Changed" })).rejects.toMatchObject({ status: 409 });
});
it("rejects missing or changed media before publication and after it", async () => {
  const request = await input(); state.files.set(file.key, Buffer.from("wrong"));
  await expect(createPublication("private", request)).rejects.toMatchObject({ status: 503 }); expect(table("world_publications")).toEqual([]);
  state.files.set(file.key, Buffer.from("image")); await createPublication("private", request); state.files.delete(file.key);
  await expect(publicationFile("public1", "view_view")).rejects.toMatchObject({ status: 503 });
});
it("unpublishing revokes both metadata and file access including old URLs", async () => {
  await createPublication("private", await input()); await unpublishWorld("private", "public1");
  await expect(readPublication("public1")).rejects.toMatchObject({ status: 404 });
  await expect(publicationFile("public1", "view_view")).rejects.toMatchObject({ status: 404 });
});
it("blocks a selected view that shows an unselected place", () => {
  const sources = { scenes: table("place_scenes"), views: [{ ...table("place_views")[0], sources: [{ place_id: "other" }] }], paths: [], meshes: [], materials: [], illustrations: [], studies: [], connections: [], map: null };
  expect(() => selectPublication(sources as unknown as Parameters<typeof selectPublication>[0], { place_ids: ["city"], view_ids: ["view"], path_ids: [] })).toThrow(/every place/);
});
it("forks exactly the public selection with copied bytes, one receipt and private ownership", async () => {
  await createPublication("private", await input());
  const [one, two] = await Promise.all([forkPublication("public1", "fork1"), forkPublication("public1", "fork1")]);
  expect(one).toEqual(two); expect(table("publication_forks")).toHaveLength(1);
  expect(table("session_owners")).toMatchObject([{ _id: one.session_id, owner_token: "new-owner" }]);
  expect(table("creator_worlds")).toMatchObject([{ _id: one.session_id, visibility: "private" }]);
  const scenes = table("place_scenes").filter(x => x.session_id === one.session_id);
  expect(scenes).toHaveLength(1); expect(scenes[0]).toMatchObject({ source_node_id: null, source_image_key: null, revision: 1 });
  expect(scenes[0]).not.toHaveProperty("generation_sources"); expect(table("creator_notes")).toHaveLength(1);
  await unpublishWorld("private", "public1"); state.files.delete(file.key);
  expect((await publicationLibraryFile(one.session_id, "view_view")).bytes.toString()).toBe("image");
  expect((await publicationLibrary(one.session_id)).title).toBe("Shared city");
  expect(await forkPublication("public1", "fork1")).toEqual(one);
  await expect(forkPublication("public1", "newfork")).rejects.toMatchObject({ status: 404 });
  state.allowed = false; await expect(publicationLibraryFile(one.session_id, "view_view")).rejects.toThrow("forbidden");
});
it("exports selected files with portable hashes and no private storage locations", async () => {
  await createPublication("private", await input()); const zip = await JSZip.loadAsync(await publicationZip("public1"));
  const metadata = JSON.parse(await zip.file("publication.json")!.async("string"));
  expect(metadata.format).toBe("openflipbook-publication"); expect(metadata.files).toMatchObject([{ sha256: file.sha256, file: "files/view_view" }]);
  expect(JSON.stringify(metadata)).not.toContain("private"); expect(await zip.file("files/view_view")!.async("string")).toBe("image");
});

function connectedFixture() {
  const city = table("place_scenes")[0]!;
  city.definition.objects = [{ id: "bench", entity_id: "entity_bench", kind: "bench", label: "Bench", x: 20, z: 20,
    width: 2, depth: 1, height: 1, heading: 0, color: "#aabbcc" }];
  for (const [id, label] of [["yard", "Yard"], ["unselected", "Hidden place"]]) table("place_scenes").push({
    _id: `private:${id}`, id: `scene_${id}`, session_id: "private", place_id: id, revision: 3,
    definition: { ...structuredClone(definition), label }, source_node_id: null, source_image_key: null, updated_at: "2026-10-03T00:00:00.000Z",
  });
  const geos = table("place_scenes").flatMap((scene, i) => sceneGeos(scene as PlaceSceneSnapshot, []).map(geo => geo.id === scene.place_id ? {
    ...geo, pos: { x: 40 + i * 80, y: 40 }, identity_anchor: { image_key: "secret private image" }, state: { secret: "private fact" },
  } : geo));
  table("world_map").push({ _id: "private", entities: geos, private_notes: "secret" });
  table("world_state").push({ _id: "private", entities: [{ id: "entity_bench", facts: ["secret private fact"], reference_image_url: "secret private image" }] });
  for (const [id, a, b] of [["gate", "city", "yard"], ["hidden_gate", "yard", "unselected"]]) table("place_connections").push({
    _id: `private:${id}`, session_id: "private", id, version: 1, kind: "boundary", a: { place_id: a, side: "east", offset: 40 },
    b: { place_id: b, side: "west", offset: 40 }, width: 2, created_at: "2026-10-03T00:00:00.000Z", private_note: "secret",
  });
}
const connectedInput = async () => ({ ...await input(), place_ids: ["city", "yard"] });

it.each(["definitions", "view"])("requires every place captured in a camera video (%s source)", async extra => {
  connectedFixture();
  table("motion_studies").push({ _id: "private:study", id: "study", session_id: "private", source: {
    view: { root_place_id: "city", sources: [{ place_id: "city", revision: 1 }, ...(extra === "view" ? [{ place_id: "yard", revision: 3 }] : [])] },
    definitions: [{ place_id: "city", revision: 1 }, ...(extra === "definitions" ? [{ place_id: "yard", revision: 3 }] : [])],
  } });
  table("path_videos").push({ _id: "private:video", id: "video", session_id: "private", study_id: "study", status: "ready", video: file,
    media: { audio_streams: 0, duration: 3 } });
  await expect(createPublication("private", { ...await input(), path_ids: ["video"] })).rejects.toThrow(/every place shown/);
  expect(table("world_publications")).toEqual([]);
  const request = { ...await connectedInput(), path_ids: ["video"] };
  expect((await createPublication("private", request)).publication.videos).toHaveLength(1);
});
it("rejects a camera video's missing captured source", async () => {
  table("path_videos").push({ _id: "private:video", id: "video", session_id: "private", study_id: "missing", status: "ready", video: file,
    media: { audio_streams: 0, duration: 3 } });
  await expect(createPublication("private", { ...await input(), path_ids: ["video"] })).rejects.toThrow(/source is missing/);
});
it("does not derive public capture metadata from a replaced saved study", async () => {
  const study = { _id: "private:study", id: "study", session_id: "private", source: {
    view: { root_place_id: "city", sources: [{ place_id: "city", revision: 1 }] }, definitions: [{ place_id: "city", revision: 1 }],
  } };
  table("motion_studies").push(study);
  table("path_videos").push({ _id: "private:video", id: "video", session_id: "private", study_id: "study",
    study_sha256: sha(Buffer.from(JSON.stringify(study))), status: "ready", video: file, media: { audio_streams: 0, duration: 3 } });
  study.source.definitions[0]!.revision = 2;
  await expect(createPublication("private", { ...await input(), path_ids: ["video"] })).rejects.toThrow(/capture receipt changed/);
});

it("freezes only selected placement numbers and connections and rebuilds a fork's canonical shared graph", async () => {
  connectedFixture();
  await createPublication("private", await connectedInput());
  const published = await readPublication("public1"), json = JSON.stringify(published);
  expect(published.placements).toMatchObject([{ place_id: "city", pos: { x: 40, y: 40 } }, { place_id: "yard", pos: { x: 120, y: 40 } }]);
  expect(published.connections?.map(c => c.id)).toEqual(["gate"]);
  for (const omitted of ["unselected", "hidden_gate", "secret", "private_notes", "identity_anchor", "private_note"]) expect(json).not.toContain(omitted);
  expect(publicationPlaceNetwork(published, "city")?.chunks.map(c => [c.scene.place_id, c.x, c.z])).toEqual([["city", 0, 0], ["yard", 80, 0]]);
  // A later private edit or removal cannot change the public graph or fork it.
  table("world_map")[0]!.entities[0].pos.x = -500;
  table("place_connections").splice(0);
  table("place_scenes").splice(0);
  expect(await readPublication("public1")).toEqual(published);
  const { session_id: sid } = await forkPublication("public1", "connected_fork");
  const scenes = table("place_scenes").filter(s => s.session_id === sid) as PlaceSceneSnapshot[];
  const map = table("world_map").find(m => m._id === sid)!;
  const entities = table("world_state").find(m => m._id === sid)!.entities;
  const links = table("place_connections").filter(c => c.session_id === sid);
  const network = placeNetwork("city", scenes, map.entities as WorldEntityGeo[], links as never)!;
  expect(network.chunks.map(c => [c.scene.place_id, c.x, c.z])).toEqual([["city", 0, 0], ["yard", 80, 0]]);
  expect(map.entities.map((g: WorldEntityGeo) => g.id)).toEqual(["city", "bench", "yard"]);
  const bench = map.entities.find((g: WorldEntityGeo) => g.id === "bench");
  expect(bench).toMatchObject({ entity_id: "entity_bench", parent_id: "city", scene_id: scenes[0]!.id });
  expect(entities.find((e: Document) => e.id === "entity_bench")).toMatchObject({ scene_id: scenes[0]!.id, name: "Bench", pinned_by_user: true,
    reference_image_url: null, appears_on_node_ids: [], first_seen_node_id: null, last_seen_node_id: null });
  expect(JSON.stringify([map, entities, links])).not.toContain("secret");
  expect(scenes.every(s => s.revision === 1 && s.source_node_id === null && s.source_image_key === null)).toBe(true);
});

it.each(["placement", "connection", "view", "study"])("rejects %s changes during publication byte verification", async change => {
  connectedFixture();
  table("motion_studies").push({ _id: "private:study", id: "study", session_id: "private", source: {
    view: { root_place_id: "city", sources: [{ place_id: "city" }] }, definitions: [{ place_id: "city" }],
  } });
  const request = await connectedInput();
  state.onRead = () => {
    if (change === "placement") table("world_map")[0]!.entities[0].pos.x++;
    if (change === "connection") table("place_connections")[0]!.width++;
    if (change === "view") table("place_views")[0]!.mode = "walk";
    if (change === "study") table("motion_studies")[0]!.source.definitions.push({ place_id: "unselected" });
  };
  await expect(createPublication("private", request)).rejects.toThrow(/changed during publication/);
  expect(table("world_publications")).toEqual([]);
});

it.each(["world_map", "world_state", "place_connections"])("rolls back a connected publication fork when %s cannot be written", async collection => {
  connectedFixture(); await createPublication("private", await connectedInput());
  state.failInsert = collection;
  await expect(forkPublication("public1", "connected_fork")).rejects.toThrow("write failed");
  expect(table("session_owners")).toEqual([]); expect(table("publication_forks")).toEqual([]);
  for (const name of ["place_scenes", "place_scene_versions", "world_map", "world_state", "place_connections", "creator_worlds", "publication_libraries"])
    expect(table(name).every(doc => doc.session_id === "private" || doc._id === "private")).toBe(true);
  state.failInsert = null;
  expect((await forkPublication("public1", "connected_fork")).session_id).toMatch(/^session_/);
});

it("flattens a selected nested map frame without publishing its private ancestor", async () => {
  const scene = table("place_scenes")[0]!, geos = sceneGeos(scene as PlaceSceneSnapshot, []);
  geos[0]!.parent_id = "private_frame"; geos[0]!.pos = { x: 10, y: 20 }; geos[0]!.scale = .5;
  table("world_map").push({ _id: "private", entities: [...geos, { id: "private_frame", kind: "place", pos: { x: 100, y: 200 },
    footprint: { w: 500, d: 500 }, scale: 2, visual: "secret" }] });
  await createPublication("private", await input());
  const published = await readPublication("public1");
  expect(published.placements).toMatchObject([{ place_id: "city", pos: { x: 120, y: 240 }, footprint: { w: 160, d: 160 }, scale: 1 }]);
  expect(JSON.stringify(published)).not.toContain("private_frame");
  expect(publicationGeometry(published).geos[0]).toMatchObject({ pos: { x: 120, y: 240 }, footprint: { w: 160, d: 160 }, scale: 1 });
});

it("rejects broken connected placements and cross-place object or entity bindings", async () => {
  connectedFixture();
  table("world_map")[0]!.entities.find((g: WorldEntityGeo) => g.id === "yard").pos.x++;
  await expect(createPublication("private", await connectedInput())).rejects.toThrow(/no longer align/);
  table("world_map")[0]!.entities.find((g: WorldEntityGeo) => g.id === "yard").pos.x--;
  table("place_scenes").find(s => s.place_id === "yard")!.definition.objects = [structuredClone(table("place_scenes")[0]!.definition.objects[0])];
  await expect(createPublication("private", await connectedInput())).rejects.toThrow(/share an object or entity/);
  expect(table("world_publications")).toEqual([]);
});

it("retains explicitly selected historical captures with frozen revisions, geometry hashes and provenance", async () => {
  table("place_scenes")[0]!.revision = 2;
  table("place_scenes")[0]!.definition.label = "Rebuilt city";
  const oldDefinition = structuredClone(definition), oldHash = sha(Buffer.from(JSON.stringify(oldDefinition)));
  table("motion_studies").push({ _id: "private:study", id: "study", session_id: "private", source: {
    view: { root_place_id: "city", sources: [{ place_id: "city", revision: 1, definition_sha256: oldHash }] },
    definitions: [{ place_id: "city", revision: 1, definition: oldDefinition }],
  } });
  table("path_videos").push({ _id: "private:video", id: "video", session_id: "private", study_id: "study", status: "ready", video: file,
    media: { audio_streams: 0, duration: 3 } });
  await createPublication("private", { ...await input(), path_ids: ["video"] });
  const published = await readPublication("public1");
  expect(published.scenes[0]!.revision).toBe(2);
  for (const capture of [published.views[0]!.capture, published.videos[0]!.capture]) expect(capture).toEqual({
    historical: true, provenance: "client_rendered_saved_geometry", sources: [{ place_id: "city", revision: 1, definition_sha256: oldHash }],
  });
  table("place_views")[0]!.sources[0].revision = 99;
  expect((await readPublication("public1")).views[0]!.capture?.sources[0]!.revision).toBe(1);
});

it("does not label a capture with unknown or invalid revision metadata as current", async () => {
  delete table("place_views")[0]!.sources[0].revision;
  await expect(createPublication("private", await input())).rejects.toThrow(/revision metadata is unavailable/);
  expect(table("world_publications")).toEqual([]);
});

it("reads and forks legacy publications as standalone geometry without inventing connections", async () => {
  await createPublication("private", await input());
  delete table("world_publications")[0]!.placements; delete table("world_publications")[0]!.connections;
  const published = await readPublication("public1");
  expect(publicationPlaceNetwork(published, "city")).toBeNull();
  const { session_id: sid } = await forkPublication("public1", "legacy_fork");
  expect(table("world_map").find(m => m._id === sid)!.entities[0]).toMatchObject({ id: "city", pos: { x: 40, y: 40 } });
  expect(table("place_connections").filter(c => c.session_id === sid)).toEqual([]);
});
