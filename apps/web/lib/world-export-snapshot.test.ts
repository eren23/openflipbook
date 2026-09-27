import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
import { emptyPlaceScene } from "./place-scene";

const memory = vi.hoisted(() => ({ rows: new Map<string, Document[]>(), token: "owner" as string | null, session: {} as ClientSession, reads: [] as string[], options: {} as Document,
  afterRead: (() => {}) as (name: string) => void, views: vi.fn(async () => []) }));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: async () => memory.token }));
vi.mock("./place-view-server", () => ({ snapshotPlaceViewExports: memory.views }));
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>, options: Document) => {
  memory.options = options;
  const snapshot = structuredClone(memory.rows);
  const collection = (name: string) => {
    const find = (query: Document, opts: Document) => {
      expect(opts.session).toBe(memory.session); memory.reads.push(name);
      const rows = (snapshot.get(name) ?? []).filter(row => Object.entries(query).every(([k, v]) => typeof v === "object" && v && "$in" in v ? v.$in.includes(row[k]) : row[k] === v));
      memory.afterRead(name); return structuredClone(rows);
    };
    return { findOne: async (q: Document, opts: Document) => find(q, opts)[0] ?? null,
      find: (q: Document, opts: Document) => { let limit = Infinity; const rows = find(q, opts); const c = { sort: () => c, limit: (n: number) => { limit = n; return c; }, toArray: async () => rows.slice(0, limit) }; return c; } };
  };
  return run({ collection } as unknown as Db, memory.session);
} }));
import { snapshotWorldExport } from "./world-export-snapshot";

beforeEach(() => {
  memory.rows.clear(); memory.reads = []; memory.token = "owner"; memory.afterRead = () => {}; memory.views.mockClear();
  const scene = { _id: "world:place", id: "scene", place_id: "place", session_id: "world", revision: 1, source_node_id: null, source_image_key: null, definition: emptyPlaceScene() };
  memory.rows.set("place_scenes", [scene]); memory.rows.set("place_scene_versions", [{ ...scene, _id: "world:place:1" }]);
  memory.rows.set("session_owners", [{ _id: "world", owner_token: "owner" }]);
  memory.rows.set("creator_worlds", [{ _id: "world", visibility: "private", title: "City", notes: "do not export", walk_position: { x: 1, z: 2 } }]);
});

it("captures an owned source-free world, registry tombstones and workspace without credentials or notes", async () => {
  memory.rows.set("world_state", [{ _id: "world", updated_at: new Date(1), entities: [{ id: "live" }, { id: "gone", deleted_at: new Date(2) }] }]);
  const result = await snapshotWorldExport("world");
  expect(memory.options.readConcern).toEqual({ level: "snapshot" });
  expect(result.privateOwner).toBe(true); expect(result.entities.entities).toEqual([{ id: "live" }]); expect(result.registry?.entities).toHaveLength(2);
  expect(result.workspace).toMatchObject({ title: "City", walk_position: { x: 1, z: 2 } }); expect(result.workspace).not.toHaveProperty("notes");
  expect(JSON.stringify(result)).not.toContain("owner_token"); expect(memory.views).toHaveBeenCalledWith(expect.anything(), "world", memory.session);
});
it("does not mix a concurrent structural edit into an earlier world snapshot", async () => {
  memory.afterRead = name => { if (name === "place_scenes") { memory.rows.get("place_scenes")![0]!.revision = 2; memory.rows.get("place_scene_versions")![0]!.revision = 2; } };
  const result = await snapshotWorldExport("world");
  expect(result.sceneHeads[0]!.revision).toBe(1); expect(result.scenes[0]!.revision).toBe(1); expect(memory.rows.get("place_scenes")![0]!.revision).toBe(2);
});
it("keeps scene histories ordered numerically beyond revision nine", async () => {
  const scene = memory.rows.get("place_scenes")![0]!;
  scene.revision = 10;
  memory.rows.set("place_scene_versions", [10, 1, 2].map(revision => ({ ...scene, _id: `world:place:${revision}`, revision })));
  expect((await snapshotWorldExport("world")).scenes.map(s => s.revision)).toEqual([1, 2, 10]);
});
it.each([null, "someone-else"])("rejects private and source-free worlds for credential %s", async token => {
  memory.token = token; await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 403 });
  memory.rows.delete("creator_worlds"); await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 403 }); expect(memory.views).not.toHaveBeenCalled();
});
it("retains public image-world access without exporting private views, unbound assets or deleted entities", async () => {
  memory.token = "viewer"; memory.rows.delete("creator_worlds"); memory.rows.set("nodes", [{ _id: "page", session_id: "world" }]);
  memory.rows.set("mesh_assets", [{ id: "unbound", session_id: "world", image_input: { key: "secret" } }]);
  memory.rows.set("world_state", [{ _id: "world", entities: [{ id: "gone", deleted_at: new Date() }] }]);
  const result = await snapshotWorldExport("world");
  expect(result).toMatchObject({ privateOwner: false, meshes: [], views: [], registry: null, workspace: null }); expect(result.entities.entities).toEqual([]);
  expect(memory.views).not.toHaveBeenCalled();
  expect(result.motion).toEqual({ studies: [], assets: [], reviews: [], selections: [] });
  expect(memory.reads.some(name => name.startsWith("motion_"))).toBe(false);
});
it("exports private alignment drafts only to their owner",async()=>{
  memory.rows.set("map_alignment_drafts",[{_id:"world:place",session_id:"world",place_id:"place",landmarks:[{object_id:"inn",x:20,y:30}]}]);
  expect((await snapshotWorldExport("world")).artwork.drafts).toHaveLength(1);
  memory.token="viewer";memory.rows.set("creator_worlds",[{_id:"world",visibility:"public"}]);memory.rows.set("nodes",[{_id:"page",session_id:"world"}]);
  expect((await snapshotWorldExport("world")).artwork.drafts).toEqual([]);
});
it("captures owner motion records and selections in the same snapshot, never runnable jobs", async () => {
  memory.views.mockResolvedValueOnce([{ doc: { id: "camera" } }] as never);
  memory.rows.set("motion_studies", [{ _id: "world:study", id: "study", session_id: "world", view_id: "camera" }]);
  memory.rows.set("motion_assets", [{ _id: "world:clip", id: "clip", session_id: "world" }]);
  memory.rows.set("motion_reviews", [{ _id: "world:review", id: "review", session_id: "world" }]);
  memory.rows.set("motion_selections", [{ _id: "world:study", asset_id: "clip", review_id: "review", private_extra: "omit" }]);
  memory.rows.set("motion_jobs", [{ session_id: "world", status: "queued" }]);
  memory.afterRead = name => { if (name === "motion_studies") memory.rows.get("motion_selections")![0]!.asset_id = "later"; };
  const result = await snapshotWorldExport("world");
  expect(result.motion.studies).toHaveLength(1); expect(result.motion.assets).toHaveLength(1); expect(result.motion.reviews).toHaveLength(1);
  expect(result.motion.selections).toEqual([{ _id: "world:study", asset_id: "clip", review_id: "review" }]);
  expect(memory.reads).not.toContain("motion_jobs");
});
it("refuses to export orphan motion studies or an oversized study inventory", async () => {
  memory.rows.set("motion_studies", [{ id: "study", session_id: "world", view_id: "missing" }]);
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 409 });
  memory.rows.set("motion_studies", Array.from({ length: 5001 }, (_, i) => ({ id: `${i}`, session_id: "world" })));
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 413 });
});
it("keeps unused owner mesh/material assets in the content export", async () => {
  memory.rows.set("mesh_assets", [{ id: "unbound", session_id: "world" }]); memory.rows.set("material_assets", [{ id: "paint", session_id: "world" }]);
  const result = await snapshotWorldExport("world"); expect(result.meshes.map(m => m.id)).toEqual(["unbound"]); expect(result.materials.map(m => m.id)).toEqual(["paint"]);
});
it("rejects node overflow rather than exporting a truncated graph", async () => {
  memory.rows.set("nodes", Array.from({ length: 501 }, (_, i) => ({ _id: String(i), session_id: "world" })));
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 413 });
});
it("rejects missing or inconsistent current scene history", async () => {
  memory.rows.set("place_scene_versions", []); await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 409 });
  memory.rows.set("place_scene_versions", [{ ...memory.rows.get("place_scenes")![0], definition: { ...emptyPlaceScene(), width: 99 } }]);
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 409 });
});
it("rejects missing referenced assets, even when another world's asset has the same local ID", async () => {
  for (const name of ["place_scenes", "place_scene_versions"]) memory.rows.get(name)![0]!.definition = { ...emptyPlaceScene(), objects: [{ id: "statue", asset_id: "missing" }] };
  memory.rows.set("mesh_assets", [{ id: "missing", session_id: "foreign" }]);
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 409 });
});
it("rejects empty and unsafe worlds without starting unsafe reads", async () => {
  await expect(snapshotWorldExport("../world")).rejects.toMatchObject({ status: 400 }); expect(memory.reads).toEqual([]);
  memory.rows.clear(); await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 404 });
});
it("rejects oversized metadata and connection inventories without slicing", async () => {
  memory.rows.get("place_scenes")![0]!.extra = "x".repeat(32 * 1024 * 1024);
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 413 });
  delete memory.rows.get("place_scenes")![0]!.extra;
  memory.rows.set("place_connections", Array.from({ length: 257 }, (_, i) => ({ id: String(i), session_id: "world" })));
  await expect(snapshotWorldExport("world")).rejects.toMatchObject({ status: 409 });
});
