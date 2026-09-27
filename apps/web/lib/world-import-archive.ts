import JSZip from "jszip";
import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";

export const WORLD_IMPORT_BYTES = 384 * 1024 * 1024;
export const archiveHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const invalidArchive = (message: string): never => { throw new CreatorError(message, 422); };
export function archiveObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidArchive("Expected an archive object");
  return value as Record<string, unknown>;
}
export function archiveList(value: unknown, limit = 5000): unknown[] {
  if (!Array.isArray(value) || value.length > limit) return invalidArchive("Invalid or oversized archive list");
  return value;
}

// Match Sketch's bounded JSZip streaming reader, but account for every binary
// entry as well. Do not trust ZIP headers to bound decompressed allocations.
async function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream("uint8array");
    const chunks: Uint8Array[] = []; let size = 0, failed = false;
    stream.on("data", (chunk: Uint8Array) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; stream.pause(); reject(new CreatorError("Archive expands beyond its size limit", 413)); }
      else chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => { if (!failed) resolve(Buffer.concat(chunks, size)); });
    stream.resume();
  });
}
function safeJson(bytes: Buffer): unknown {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return invalidArchive("Invalid archive JSON"); }
  let count = 0;
  function visit(item: unknown, depth: number) {
    if (++count > 1_000_000 || depth > 64) invalidArchive("Archive metadata is too complex");
    if (typeof item === "number" && !Number.isFinite(item)) invalidArchive("Non-finite archive number");
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || key.startsWith("$") || key.includes(".")) invalidArchive("Unsafe archive metadata key");
      visit(child, depth + 1);
    }
  }
  visit(value, 0); return value;
}
export interface WorldArchive {
  sha256: string;
  manifest: Record<string, unknown>;
  files: Map<string, Buffer>;
  json(path: string): unknown;
}
export async function readWorldArchive(bytes: Buffer): Promise<WorldArchive> {
  if (!bytes.length || bytes.length > WORLD_IMPORT_BYTES) throw new CreatorError("World archive exceeds 384 MiB", 413);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return invalidArchive("Choose a valid world ZIP archive"); }
  if (Object.keys(zip.files).length > 20000) return invalidArchive("Archive contains too many entries");
  for (const entry of Object.values(zip.files)) {
    const original = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (original !== entry.name || original.startsWith("/") || original.includes("\\") || original.split("/").some(p => p === ".." || p === ".") || [...original].some(c => c.charCodeAt(0) < 32)) invalidArchive("Unsafe archive path");
  }
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) return invalidArchive("This ZIP has no versioned world manifest");
  const manifest = archiveObject(safeJson(await readEntry(manifestEntry, 4 * 1024 * 1024)));
  if (manifest.format !== "openflipbook-world-content" || ![1,2,3].includes(manifest.version as number) || manifest.visibility !== "owner" || manifest.metadata_consistency !== "database_snapshot") return invalidArchive("Restore requires a snapshot export made by the world's owner");
  if (archiveList(manifest.missing_files).length || archiveList(manifest.external_resources).length) return invalidArchive("Archive is incomplete or depends on external media; nothing can be restored");
  const inventory = archiveList(manifest.files, 15000).map(archiveObject), names = new Set<string>(), files = new Map<string, Buffer>();
  let total = 0, jsonBytes = 0;
  for (const file of inventory) {
    if (typeof file.path !== "string" || file.path === "manifest.json" || names.has(file.path) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 1 || !/^[a-f0-9]{64}$/.test(String(file.sha256))) return invalidArchive("Invalid archive file inventory");
    names.add(file.path); total += Number(file.bytes);
    if (total > WORLD_IMPORT_BYTES) throw new CreatorError("World archive expands beyond 384 MiB", 413);
    const entry = zip.file(file.path); if (!entry) return invalidArchive("Archive file is missing");
    const data = await readEntry(entry, Number(file.bytes));
    if (data.length !== file.bytes || archiveHash(data) !== file.sha256) return invalidArchive("Archive file checksum or length differs");
    if (file.path.endsWith(".json")) { jsonBytes += data.length; if (jsonBytes > 32 * 1024 * 1024) throw new CreatorError("Archive metadata exceeds 32 MiB", 413); }
    files.set(file.path, data);
  }
  if (Object.values(zip.files).some(f => !f.dir && f.name !== "manifest.json" && !names.has(f.name))) return invalidArchive("Archive contains unlisted files");
  return { sha256: archiveHash(bytes), manifest, files, json: path => {
    const data = files.get(path); if (!data || !path.endsWith(".json")) return invalidArchive(`Archive metadata is missing: ${path}`);
    return safeJson(data);
  } };
}
