// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
import type * as ArchiveModule from "./world-import-archive";
const memory = vi.hoisted(() => ({ rows: new Map<string, Document[]>(), files: new Map<string, Buffer>(), token: "owner" as string | null,
  failure: "", uploadFailure: false, corrupt: false, uploads: 0, tail: Promise.resolve(), session: {} as ClientSession }));
function collection(name: string) {
  const all = () => memory.rows.get(name) ?? [];
  const find = (q: Document) => all().find(r => Object.entries(q).every(([k, v]) => r[k] === v));
  const fail = () => { if (memory.failure === name) throw new Error("Injected late write failure"); };
  return {
    findOne: async (q: Document) => structuredClone(find(q) ?? null),
    insertMany: async (docs: Document[], options: Document) => { expect(options.session).toBe(memory.session); fail(); if (docs.some(d => all().some(row => row._id === d._id))) throw Object.assign(new Error("Duplicate"), { code: 11000 }); memory.rows.set(name, [...all(), ...structuredClone(docs)]); },
    insertOne: async (doc: Document, options: Document) => collection(name).insertMany([doc], options),
    updateOne: async (q: Document, patch: Document, options: Document = {}) => {
      fail(); const row = find(q);
      if (row) Object.assign(row, patch.$set ?? {}); else if (options.upsert) memory.rows.set(name, [...all(), structuredClone(patch.$setOnInsert)]);
      return { matchedCount: row ? 1 : 0 };
    },
  };
}
vi.mock("./db", () => ({ getDb: async () => ({ collection }), withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const beforeTurn = memory.tail; let release!: () => void; memory.tail = new Promise<void>(r => { release = r; }); await beforeTurn;
  const before = structuredClone(memory.rows);
  try { return await run({ collection } as unknown as Db, memory.session); } catch (e) { memory.rows = before; throw e; } finally { release(); }
} }));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: async () => memory.token }));
vi.mock("./r2", () => ({ getStoredBytes: async (key: string) => memory.files.has(key) ? { bytes: memory.files.get(key)!, contentType: "application/zip" } : null,
  uploadJpeg: async (key: string, bytes: Buffer) => { if (memory.uploadFailure) throw new Error("Storage failed"); memory.uploads++; memory.files.set(key, memory.corrupt ? Buffer.from("bad") : bytes); } }));
vi.mock("./world-import-archive", async original => ({ ...await original<typeof ArchiveModule>(), readWorldArchive: async () => ({}) }));
const copied = ["nodes", "world_map", "world_state", "creator_worlds", "place_scenes", "place_scene_versions", "place_connections", "mesh_sources", "mesh_assets", "material_assets", "place_views", "illustration_assets", "map_artwork_heads", "map_artwork_versions", "motion_studies", "motion_assets", "motion_reviews", "motion_selections"];
vi.mock("./world-import-content", () => ({ prepareWorldImport: async (_archive: unknown, sid: string) => ({ session_id: sid, title: "World", preview: { title: "World", places: 1 },
  records: Object.fromEntries(copied.map(name => [name, [{ _id: `${sid}:${name}`, session_id: sid, value: "original" }]])), uploads: [{ key: `${sid}/asset`, bytes: Buffer.from("asset"), contentType: "image/png" }] }) }));
import { applyWorldImport, inspectWorldImport, readWorldImport } from "./world-import";
const bytes = Buffer.from("archive");
beforeEach(() => { memory.rows.clear(); memory.files.clear(); memory.token = "owner"; memory.failure = ""; memory.uploadFailure = false; memory.corrupt = false; memory.uploads = 0; memory.tail = Promise.resolve(); });
it("stages a preview without a world, then publishes content and ownership together", async () => {
  const preview = await inspectWorldImport("request", bytes); expect(preview.status).toBe("preview");
  expect([...memory.rows.keys()]).toEqual(["world_imports"]);
  const applied = await applyWorldImport("request", preview.sha256); expect(applied.status).toBe("applied");
  for (const name of copied) expect(memory.rows.get(name)).toHaveLength(1);
  expect(memory.rows.get("session_owners")![0]).toMatchObject({ _id: applied.session_id, owner_token: "owner" });
  expect(await readWorldImport("request")).toEqual(applied);
});
it.each([...copied, "session_owners", "world_imports"])("rolls back all destination records when %s fails and permits exact retry", async failed => {
  const preview = await inspectWorldImport("request", bytes), before = structuredClone(memory.rows);
  memory.failure = failed; await expect(applyWorldImport("request", preview.sha256)).rejects.toThrow();
  expect(memory.rows).toEqual(before); memory.failure = "";
  expect((await applyWorldImport("request", preview.sha256)).status).toBe("applied");
});
it("replays lost responses and concurrent confirmations without new copies or later uploads", async () => {
  const preview = await inspectWorldImport("request", bytes);
  const results = await Promise.all([applyWorldImport("request", preview.sha256), applyWorldImport("request", preview.sha256)]);
  expect(results[0]).toEqual(results[1]); expect(memory.rows.get("session_owners")).toHaveLength(1);
  const uploads = memory.uploads; memory.files.clear();
  expect(await applyWorldImport("request", preview.sha256)).toEqual(results[0]); expect(memory.uploads).toBe(uploads);
});
it("rejects reused IDs, wrong hashes, cross-owner access and lost destination ownership", async () => {
  const preview = await inspectWorldImport("request", bytes);
  await expect(inspectWorldImport("request", Buffer.from("different"))).rejects.toMatchObject({ status: 409 });
  await expect(applyWorldImport("request", "different")).rejects.toMatchObject({ status: 409 });
  memory.token = "stranger"; await expect(readWorldImport("request")).rejects.toMatchObject({ status: 404 });
  memory.token = "owner"; await applyWorldImport("request", preview.sha256);
  memory.rows.set("session_owners", []); await expect(applyWorldImport("request", preview.sha256)).rejects.toMatchObject({ status: 403 });
});
it("recovers a missing staged archive only from the exact original re-upload", async () => {
  const preview = await inspectWorldImport("request", bytes); memory.files.clear();
  await expect(applyWorldImport("request", preview.sha256)).rejects.toMatchObject({ status: 503 });
  expect(await inspectWorldImport("request", bytes)).toEqual(preview); expect((await applyWorldImport("request", preview.sha256)).status).toBe("applied");
});
it("does not publish on storage failure, absent credentials or invalid request identity", async () => {
  memory.uploadFailure = true; await expect(inspectWorldImport("request", bytes)).rejects.toThrow(); expect(memory.rows.size).toBe(0);
  memory.uploadFailure = false; const preview = await inspectWorldImport("request", bytes); memory.uploadFailure = true;
  await expect(applyWorldImport("request", preview.sha256)).rejects.toThrow(); expect(memory.rows.has("session_owners")).toBe(false);
  memory.token = null; await expect(inspectWorldImport("request", bytes)).rejects.toMatchObject({ status: 409 });
  await expect(inspectWorldImport("../request", bytes)).rejects.toMatchObject({ status: 400 });
});
it("verifies uploaded bytes before publishing any world metadata", async () => {
  const preview = await inspectWorldImport("request", bytes); memory.corrupt = true;
  await expect(applyWorldImport("request", preview.sha256)).rejects.toMatchObject({ status: 503 });
  expect(memory.rows.has("session_owners")).toBe(false); memory.corrupt = false;
  expect((await applyWorldImport("request", preview.sha256)).status).toBe("applied");
});
