import { createHash } from "node:crypto";
import sharp from "sharp";
import { getDb } from "./db";
import { requireCreator } from "./creator";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";
import { getStoredBytes } from "./r2";
import type { SceneDoc } from "./place-scene-store";
import { validateLandmarkReferences, type LandmarkReferenceDoc } from "./illustration-landmarks";

/** Owner-reviewed source rectangles; no canonical geometry or artwork is changed. */
export async function landmarkReferenceAction(sid: string, pid: string, input?: unknown) {
  if (!isSafeId(sid) || !isSafeId(pid)) throw new CreatorError("Invalid source-map identity", 400);
  await requireCreator(sid);
  const db = await getDb(), scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}`, session_id: sid });
  if (!scene?.source_image_key) throw new CreatorError("This saved place has no original map artwork", 404);
  const stored = await getStoredBytes(scene.source_image_key, AbortSignal.timeout(30_000));
  if (!stored) throw new CreatorError("Original map artwork is unavailable", 503);
  const sha = createHash("sha256").update(stored.bytes).digest("hex"), metadata = await sharp(stored.bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.orientation && metadata.orientation !== 1) throw new CreatorError("Original map format cannot be referenced", 409);
  const col = db.collection<LandmarkReferenceDoc>("source_landmark_references"), key = `${sid}:${pid}:${sha}`;
  if (input === undefined) {
    const record = await col.findOne({ _id: key, session_id: sid, place_id: pid, source_sha256: sha });
    return { source_sha256: sha, source_width: metadata.width, source_height: metadata.height, landmarks: record?.landmarks ?? [], reviewed_at: record?.reviewed_at ?? null };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid map-reference request", 400);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !["source_sha256", "landmarks", "reviewed"].includes(k)) || body.source_sha256 !== sha || body.reviewed !== true)
    throw new CreatorError("Review the exact original map before saving building references", 409);
  const labels = scene.definition.objects.filter(o => ["building", "house", "tavern"].includes(o.kind)).map(o => o.label);
  const landmarks = validateLandmarkReferences(body.landmarks, metadata.width, metadata.height, labels);
  const record: LandmarkReferenceDoc = { _id: key, session_id: sid, place_id: pid, source_sha256: sha, source_width: metadata.width, source_height: metadata.height, landmarks, reviewed_at: new Date() };
  const { _id, ...fields } = record;
  await col.updateOne({ _id }, { $set: fields }, { upsert: true });
  return { source_sha256: sha, source_width: metadata.width, source_height: metadata.height, landmarks, reviewed_at: record.reviewed_at };
}
