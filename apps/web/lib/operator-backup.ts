import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { BSON, type Document } from "mongodb";

export interface OperatorCollection { name: string; options: Document; indexes: Document[] }
export interface OperatorObjectMetadata {
  content_type?: string; cache_control?: string; content_disposition?: string; content_encoding?: string;
  content_language?: string; metadata?: Record<string, string>;
}
interface FileReceipt { file: string; bytes: number; sha256: string }
export interface OperatorBackupManifest {
  version: 1; scope: "full_operator_backup"; created_at: string; database: string; bucket: string;
  collections: (OperatorCollection & FileReceipt & { rows: number })[];
  objects: (OperatorObjectMetadata & FileReceipt & { key: string })[];
}
export interface OperatorRestoreReceipt { _id: string; state: "copying" | "data_imported" | "applied" }
export interface OperatorDatabase {
  name: string;
  inventory(): Promise<OperatorCollection[]>;
  rows(name: string): AsyncIterable<Document>;
  receipt(id: string): Promise<OperatorRestoreReceipt | null>;
  beginRestore(id: string): Promise<void>;
  importMetadata(manifest: OperatorBackupManifest, readRows: (file: string) => AsyncIterable<Document>, id: string): Promise<void>;
  finishRestore(manifest: OperatorBackupManifest, id: string): Promise<void>;
}
export interface OperatorBlobStore {
  bucket: string;
  keys(): AsyncIterable<string>;
  read(key: string): Promise<{ body: AsyncIterable<Uint8Array>; metadata: OperatorObjectMetadata }>;
  write(key: string, body: AsyncIterable<Uint8Array>, bytes: number, metadata: OperatorObjectMetadata): Promise<void>;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;
function fail(message: string): never { throw new Error(message); }

async function digest(body: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of body) { bytes += chunk.byteLength; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}
async function checkedFile(directory: string, receipt: FileReceipt) {
  if (!/^(collections|objects)\/[0-9]+\.(jsonl|bin)$/.test(receipt.file)) fail("Unsafe backup file path");
  const file = resolve(directory, receipt.file);
  // Do not follow symlinks even for an otherwise well-formed manifest path.
  const parent = await lstat(resolve(directory, receipt.file.split("/")[0]!));
  const stat = await lstat(file);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) fail("Backup files must be regular local files");
  const actual = await digest(createReadStream(file));
  if (actual.bytes !== receipt.bytes || actual.sha256 !== receipt.sha256) fail("Backup file checksum mismatch");
  return file;
}
async function* documents(directory: string, file: string) {
  const reader = createInterface({ input: createReadStream(resolve(directory, file)), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) fail("Invalid empty metadata row");
    const row: unknown = BSON.EJSON.parse(line, { relaxed: false });
    if (!row || typeof row !== "object" || Array.isArray(row) || !("_id" in row)) fail("Invalid metadata document");
    yield row as Document;
  }
}
function validateManifest(value: unknown): OperatorBackupManifest {
  if (!value || typeof value !== "object") fail("Invalid operator backup manifest");
  const m = value as OperatorBackupManifest;
  if (m.version !== 1 || m.scope !== "full_operator_backup" || !m.database || !m.bucket || !Number.isFinite(Date.parse(m.created_at))
    || !Array.isArray(m.collections) || !Array.isArray(m.objects)) fail("Invalid operator backup manifest");
  const files = new Set<string>(), names = new Set<string>(), keys = new Set<string>();
  for (const row of [...m.collections, ...m.objects]) {
    if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !hex.test(row.sha256) || typeof row.file !== "string" || files.has(row.file)) fail("Invalid backup file receipt");
    files.add(row.file);
  }
  for (const row of m.collections) {
    if (typeof row.name !== "string" || !row.name || row.name.startsWith("system.") || row.name.includes("\0") || names.has(row.name)
      || !Number.isSafeInteger(row.rows) || row.rows < 0 || !Array.isArray(row.indexes) || !row.options || typeof row.options !== "object"
      || !/^collections\/[0-9]+\.jsonl$/.test(row.file)) fail("Invalid backup collection");
    names.add(row.name);
  }
  for (const row of m.objects) {
    if (typeof row.key !== "string" || !row.key || row.key.includes("\0") || keys.has(row.key) || !/^objects\/[0-9]+\.bin$/.test(row.file)) fail("Invalid backup object");
    keys.add(row.key);
    for (const field of ["content_type", "cache_control", "content_disposition", "content_encoding", "content_language"] as const)
      if (row[field] !== undefined && typeof row[field] !== "string") fail("Invalid object metadata");
    if (row.metadata !== undefined && (!row.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata) || Object.values(row.metadata).some(v => typeof v !== "string"))) fail("Invalid object metadata");
  }
  return m;
}

/** Operator recovery preserves complete ownership, notes, spend and job history.
 * Call only while all web/worker writers have stopped and drained. */
export async function createOperatorBackup(directory: string, db: OperatorDatabase, store: OperatorBlobStore) {
  await mkdir(directory, { mode: 0o700 }); // existing directories are never overwritten
  await mkdir(resolve(directory, "collections"), { mode: 0o700 });
  await mkdir(resolve(directory, "objects"), { mode: 0o700 });
  const manifest: OperatorBackupManifest = { version: 1, scope: "full_operator_backup", created_at: new Date().toISOString(), database: db.name, bucket: store.bucket, collections: [], objects: [] };
  for (const [index, collection] of (await db.inventory()).entries()) {
    const file = `collections/${index}.jsonl`, handle = await open(resolve(directory, file), "wx", 0o600), hash = createHash("sha256"); let rows = 0, bytes = 0;
    try { for await (const row of db.rows(collection.name)) {
      const data = Buffer.from(BSON.EJSON.stringify(row, { relaxed: false }) + "\n");
      await handle.writeFile(data); hash.update(data); rows++; bytes += data.length;
    } } finally { await handle.close(); }
    manifest.collections.push({ ...collection, file, rows, bytes, sha256: hash.digest("hex") });
  }
  for await (const key of store.keys()) {
    const file = `objects/${manifest.objects.length}.bin`, object = await store.read(key), handle = await open(resolve(directory, file), "wx", 0o600), hash = createHash("sha256"); let bytes = 0;
    try { for await (const chunk of object.body) { await handle.writeFile(chunk); hash.update(chunk); bytes += chunk.byteLength; } }
    finally { await handle.close(); }
    manifest.objects.push({ ...object.metadata, key, file, bytes, sha256: hash.digest("hex") });
  }
  // Written last: an interrupted backup has no complete manifest and cannot restore.
  await writeFile(resolve(directory, "manifest.json"), BSON.EJSON.stringify(manifest, { relaxed: true }), { flag: "wx", mode: 0o600 });
  return manifest;
}

/** Validate every byte and BSON row before touching an empty destination.
 * A durable marker makes failed copies/index creation resumable with this exact backup. */
export async function restoreOperatorBackup(directory: string, db: OperatorDatabase, store: OperatorBlobStore) {
  const raw = await readFile(resolve(directory, "manifest.json"), "utf8"), manifest = validateManifest(BSON.EJSON.parse(raw, { relaxed: true }));
  const id = `restore-${sha(raw)}`;
  for (const row of [...manifest.collections, ...manifest.objects]) await checkedFile(directory, row);
  for (const row of manifest.collections) { let count = 0; for await (const doc of documents(directory, row.file)) {
    if (row.name === "operator_restore_receipts" && doc._id === id) fail("Restore control receipt collides with source data"); count++;
  } if (count !== row.rows) fail("Backup metadata row count mismatch"); }
  const receipt = await db.receipt(id);
  if (receipt && !["copying", "data_imported", "applied"].includes(receipt.state)) fail("Invalid destination restore receipt");
  if (receipt?.state === "applied") return { id, state: "applied" as const, replay: true };
  if (!receipt) {
    if ((await db.inventory()).length) fail("Restore requires an empty destination database");
    for await (const _key of store.keys()) fail("Restore requires an empty destination bucket");
    await db.beginRestore(id);
  }
  if (!receipt || receipt.state === "copying") {
    const expected = new Map(manifest.objects.map(row => [row.key, row]));
    for await (const key of store.keys()) if (!expected.has(key)) fail("Unexpected destination object during restore");
    for (const row of manifest.objects) {
      await checkedFile(directory, row);
      await store.write(row.key, createReadStream(resolve(directory, row.file)), row.bytes, row);
    }
    await db.importMetadata(manifest, file => documents(directory, file), id);
  }
  await db.finishRestore(manifest, id);
  return { id, state: "applied" as const, replay: false };
}
