// @vitest-environment node
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, ObjectId, Long, Binary, type Document } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorBackup, restoreOperatorBackup, type OperatorDatabase, type OperatorBlobStore, type OperatorCollection, type OperatorObjectMetadata, type OperatorRestoreReceipt } from "./operator-backup";
import { parseBackupCommand } from "../scripts/operator-backup";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function target() { const root = await mkdtemp(join(tmpdir(), "operator-backup-test-")); directories.push(root); return join(root, "backup"); }
function database(initial: Record<string, Document[]> = {}) {
  const rows = new Map(Object.entries(initial));
  const receipts = new Map<string, OperatorRestoreReceipt>();
  const options: OperatorCollection[] = Object.keys(initial).map(name => ({ name, options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }, { name: "owner_idx", key: { owner_token: 1 }, unique: true, sparse: true }] }));
  const begin = vi.fn(async (id: string) => { receipts.set(id, { _id: id, state: "copying" }); });
  const importMetadata: OperatorDatabase["importMetadata"] = vi.fn(async (manifest, readRows, id) => {
    const next = new Map<string, Document[]>();
    for (const c of manifest.collections) { const items = []; for await (const row of readRows(c.file)) items.push(row); next.set(c.name, items); }
    for (const [name, items] of next) rows.set(name, items);
    receipts.set(id, { _id: id, state: "data_imported" });
  });
  const finish = vi.fn(async (_manifest, id: string) => { receipts.set(id, { _id: id, state: "applied" }); });
  const db: OperatorDatabase = { name: "isolated_test", inventory: async () => options, async *rows(name) { yield* rows.get(name) ?? []; }, receipt: async id => receipts.get(id) ?? null, beginRestore: begin, importMetadata, finishRestore: finish };
  return { db, rows, receipts, begin, importMetadata, finish };
}
function storage(initial: Record<string, { bytes: Buffer; metadata: OperatorObjectMetadata }> = {}) {
  const objects = new Map(Object.entries(initial));
  const write = vi.fn<OperatorBlobStore["write"]>(async (key, body, _length, metadata) => {
    const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
    objects.set(key, { bytes: Buffer.concat(chunks), metadata });
  });
  const store: OperatorBlobStore = { bucket: "isolated_bucket", async *keys() { yield* objects.keys(); }, async read(key) {
    const object = objects.get(key); if (!object) throw new Error("Missing object");
    return { metadata: object.metadata, body: (async function*() { yield object.bytes; })() };
  }, write };
  return { store, objects, write };
}
async function fixture(directory: string) {
  const owner = new ObjectId(), bytes = Buffer.from([0, 255, 1, 8]);
  const db = database({
    session_owners: [{ _id: "world", owner_token: "private-secret", created_at: new Date("2026-01-01T00:00:00Z"), owner }],
    notes: [{ _id: "note", body: "Private operator recovery includes notes" }],
    generation_spend: [{ _id: "ledger", committed: Long.fromString("9007199254740993") }],
    path_videos: [{ _id: "job", status: "needs_review", committed: 1.25, work_token: "durable-history", bytes: new Binary(bytes) }],
    world_publications: [{ _id: "publication", active: true }], publication_libraries: [{ _id: "fork", files: [] }], publication_forks: [{ _id: "receipt", owner_token: "private-secret" }],
  });
  const store = storage({ "world/final.png": { bytes, metadata: { content_type: "image/png", cache_control: "private, no-store", metadata: { sha256: "unchanged" } } } });
  const manifest = await createOperatorBackup(directory, db.db, store.store);
  return { db, store, manifest };
}
describe("full operator backups", () => {
  it("preserves all collections, BSON owner data, notes, job history, ledgers and exact object metadata", async () => {
    const directory = await target(), source = await fixture(directory), db = database(), store = storage();
    const result = await restoreOperatorBackup(directory, db.db, store.store);
    expect(result.state).toBe("applied");
    expect([...db.rows.keys()]).toEqual(source.manifest.collections.map(c => c.name));
    for (const [name, rows] of source.db.rows) expect(BSON.EJSON.stringify(db.rows.get(name), { relaxed: false })).toBe(BSON.EJSON.stringify(rows, { relaxed: false }));
    expect(store.objects.get("world/final.png")?.bytes).toEqual(source.store.objects.get("world/final.png")?.bytes);
    expect(store.objects.get("world/final.png")?.metadata.cache_control).toBe("private, no-store");
    expect(db.finish).toHaveBeenCalledWith(source.manifest, result.id);
    expect(db.finish.mock.calls[0]![0].collections[0]!.indexes[1]).toMatchObject({ unique: true, sparse: true });
  });
  it("validates all bytes before any restore mutation", async () => {
    const directory = await target(); await fixture(directory);
    await writeFile(join(directory, "objects/0.bin"), "changed");
    const db = database(), store = storage();
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("checksum");
    expect(db.begin).not.toHaveBeenCalled(); expect(store.write).not.toHaveBeenCalled();
  });
  it("rejects existing destination data and never overwrites its objects", async () => {
    const directory = await target(); await fixture(directory);
    const db = database({ notes: [{ _id: "old" }] }), store = storage();
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("empty destination database");
    const empty = database(), populated = storage({ foreign: { bytes: Buffer.from("old"), metadata: {} } });
    await expect(restoreOperatorBackup(directory, empty.db, populated.store)).rejects.toThrow("empty destination bucket");
    expect(populated.write).not.toHaveBeenCalled(); expect(empty.begin).not.toHaveBeenCalled();
  });
  it("retries a partial byte copy under the same receipt without importing duplicate metadata", async () => {
    const directory = await target(); await fixture(directory); const db = database(), store = storage();
    store.write.mockRejectedValueOnce(new Error("interrupted"));
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("interrupted");
    expect(db.importMetadata).not.toHaveBeenCalled();
    const result = await restoreOperatorBackup(directory, db.db, store.store);
    expect(result.state).toBe("applied"); expect(db.begin).toHaveBeenCalledTimes(1); expect(db.importMetadata).toHaveBeenCalledTimes(1);
    const replay = await restoreOperatorBackup(directory, db.db, store.store);
    expect(replay.replay).toBe(true); expect(store.write).toHaveBeenCalledTimes(2); expect(db.importMetadata).toHaveBeenCalledTimes(1);
  });
  it("retries indexes after committed metadata and blocks unexpected new objects while copying", async () => {
    const directory = await target(); await fixture(directory); const db = database(), store = storage();
    db.finish.mockRejectedValueOnce(new Error("index interrupted"));
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("index interrupted");
    await restoreOperatorBackup(directory, db.db, store.store);
    expect(db.importMetadata).toHaveBeenCalledTimes(1); expect(store.write).toHaveBeenCalledTimes(1);
    const other = database(), interrupted = storage(); interrupted.write.mockRejectedValueOnce(new Error("copy interrupted"));
    await expect(restoreOperatorBackup(directory, other.db, interrupted.store)).rejects.toThrow("copy interrupted");
    interrupted.objects.set("foreign", { bytes: Buffer.from("old"), metadata: {} });
    await expect(restoreOperatorBackup(directory, other.db, interrupted.store)).rejects.toThrow("Unexpected destination object");
  });
  it("rejects manifest path traversal and local symlinks before mutation", async () => {
    const directory = await target(); await fixture(directory); const db = database(), store = storage();
    const file = join(directory, "manifest.json"), raw = JSON.parse(await readFile(file, "utf8"));
    raw.objects[0].file = "../outside.bin"; await writeFile(file, JSON.stringify(raw));
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("Invalid backup object");
    raw.objects[0].file = "objects/0.bin"; await writeFile(file, JSON.stringify(raw));
    await rm(join(directory, "objects/0.bin")); await symlink(file, join(directory, "objects/0.bin"));
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("regular local files");
    expect(db.begin).not.toHaveBeenCalled();
  });
  it("does not overwrite an existing backup or accept a world content ZIP", async () => {
    const directory = await target(); await fixture(directory);
    await expect(fixture(directory)).rejects.toThrow();
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 4, scope: "world_content" }));
    const db = database(), store = storage();
    await expect(restoreOperatorBackup(directory, db.db, store.store)).rejects.toThrow("Invalid operator backup");
    expect(db.begin).not.toHaveBeenCalled();
  });
  it("requires an explicit quiesced declaration and empty-destination restore", () => {
    expect(parseBackupCommand(["backup", "--directory", "/tmp/example", "--quiesced"]).action).toBe("backup");
    expect(parseBackupCommand(["restore", "--directory", "/tmp/example", "--quiesced", "--empty-destination"]).action).toBe("restore");
    expect(() => parseBackupCommand(["backup", "--directory", "/tmp/example"])).toThrow("Stop web");
    expect(() => parseBackupCommand(["restore", "--directory", "/tmp/example", "--quiesced"])).toThrow();
  });
});
