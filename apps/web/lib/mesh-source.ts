import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Db } from "mongodb";
import type { NodeDoc } from "./db";
import { requireCreator, CreatorError } from "./creator";
import { isSafeId } from "./ids";
import { getStoredBytes, uploadJpeg } from "./r2";
import type { MeshSource } from "./mesh-asset";

export const MAX_MESH_SOURCE_BYTES = 12 * 1024 * 1024;
export interface MeshSourceDoc extends MeshSource {
  _id: string; session_id: string; key: string; bytes: number; created_at: Date;
  original: { key: string; sha256: string; bytes: number; content_type: string };
}
export const wireMeshSource = (source: MeshSourceDoc): MeshSource => ({ id: source.id, label: source.label,
  sha256: source.sha256, width: source.width, height: source.height, origin: source.origin });
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function meshSources(sid: string) {
  const db = await requireCreator(sid);
  const sources = await db.collection<MeshSourceDoc>("mesh_sources").find({ session_id: sid }).sort({ created_at: -1 }).limit(100).toArray();
  const nodes = await db.collection<NodeDoc>("nodes").find({ session_id: sid }).sort({ created_at: -1 }).limit(100).toArray();
  return { sources: sources.map(wireMeshSource), nodes: nodes.filter(n => n.image_key).map(n => ({ id: n._id, label: n.page_title || n.query })) };
}

export async function saveMeshSource(sid: string, input: Record<string, unknown>) {
  const db = await requireCreator(sid);
  let bytes: Buffer, label: string, origin: MeshSource["origin"];
  if (input.node_id !== undefined) {
    if (!isSafeId(input.node_id) || input.data_url !== undefined) throw new CreatorError("Choose one saved image", 400);
    const node = await db.collection<NodeDoc>("nodes").findOne({ _id: input.node_id, session_id: sid });
    if (!node?.image_key) throw new CreatorError("Saved world image not found", 404);
    const stored = await getStoredBytes(node.image_key);
    if (!stored) throw new CreatorError("Saved world image unavailable", 503);
    bytes = stored.bytes; label = node.page_title || node.query;
    origin = { kind: "saved_world_image", node_id: node._id, image_model: node.image_model };
  } else {
    if (typeof input.data_url !== "string" || input.data_url.length > MAX_MESH_SOURCE_BYTES * 4 / 3 + 100) throw new CreatorError("Concept image exceeds 12 MiB", 413);
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.data_url);
    if (!match) throw new CreatorError("Upload a PNG, JPEG or WebP image", 400);
    bytes = Buffer.from(match[2]!, "base64"); label = typeof input.label === "string" ? input.label.trim() : "Imported concept";
    origin = { kind: "imported_reference" };
  }
  if (!bytes.length || bytes.length > MAX_MESH_SOURCE_BYTES) throw new CreatorError("Concept image exceeds 12 MiB", 413);
  let normalized: Buffer, width: number, height: number, contentType: string;
  try {
    const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" });
    const info = await image.metadata();
    if (!info.width || !info.height || !["png", "jpeg", "webp"].includes(info.format ?? "") || (info.pages ?? 1) !== 1) throw new Error("Unsupported image");
    contentType = `image/${info.format}`;
    const output = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    normalized = output.data; width = output.info.width; height = output.info.height;
    if (width < 32 || height < 32 || normalized.length > MAX_MESH_SOURCE_BYTES) throw new Error("Invalid image dimensions");
  } catch { throw new CreatorError("Invalid concept image (single frame, at least 32px, at most 16 megapixels)", 400); }
  const sha256 = hash(normalized), originalHash = hash(bytes);
  // Content + provenance identity makes a lost upload response retry harmless.
  const id = hash(JSON.stringify([originalHash, sha256, origin]));
  const col = db.collection<MeshSourceDoc>("mesh_sources"), old = await col.findOne({ _id: `${sid}:${id}` });
  if (old) {
    try { await meshSourceBytes(old); await meshSourceBytes(old, true); return { source: wireMeshSource(old) }; }
    catch {
      // Re-importing the exact content can repair missing/corrupt immutable
      // blobs. A different image has a different identity and cannot replace it.
      await uploadJpeg(old.original.key, bytes, contentType);
      await uploadJpeg(old.key, normalized, "image/png");
      return { source: wireMeshSource(old) };
    }
  }
  const key = `${sid}/mesh-sources/${id}/input.png`, originalKey = `${sid}/mesh-sources/${id}/original`;
  await uploadJpeg(originalKey, bytes, contentType);
  await uploadJpeg(key, normalized, "image/png");
  const source: MeshSourceDoc = { _id: `${sid}:${id}`, session_id: sid, id, label: (label || "Concept image").slice(0, 160),
    key, sha256, bytes: normalized.length, width, height, origin, created_at: new Date(),
    original: { key: originalKey, sha256: originalHash, bytes: bytes.length, content_type: contentType } };
  await col.updateOne({ _id: source._id }, { $setOnInsert: source }, { upsert: true });
  return { source: wireMeshSource(source) };
}

export async function readMeshSource(db: Db, sid: string, id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new CreatorError("Choose a saved concept image", 400);
  const source = await db.collection<MeshSourceDoc>("mesh_sources").findOne({ _id: `${sid}:${id}`, session_id: sid });
  if (!source) throw new CreatorError("Concept image not found", 404);
  return source;
}

export async function meshSourceBytes(source: MeshSourceDoc, original = false) {
  const asset = original ? source.original : source;
  const stored = await getStoredBytes(asset.key, AbortSignal.timeout(30_000));
  if (!stored) throw new CreatorError("Saved concept image unavailable", 503);
  if (stored.bytes.length !== asset.bytes || hash(stored.bytes) !== asset.sha256) throw new CreatorError("Saved concept image is corrupted", 409);
  return stored.bytes;
}

export async function prepareMeshInput(source: MeshSourceDoc) {
  const bytes = await meshSourceBytes(source);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
