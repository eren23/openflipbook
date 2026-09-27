import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Db } from "mongodb";
import sharp from "sharp";
import { CreatorError } from "./creator-error";
import { prepareOwnedCameraMotion } from "./camera-motion-server";
import { getStoredBytes } from "./r2";
import type { MotionStudyDoc } from "./motion-study";
import { viewHash, type PlaceViewDoc } from "./place-view-store";

export async function currentMotionStudy(db: Db, sid: string, id: string, sha?: string, session?: ClientSession) {
  const options = session ? { session } : {};
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
  if (!study || sha && viewHash(study) !== sha) throw new CreatorError("Motion study changed or is unavailable", 409);
  const prepared = await prepareOwnedCameraMotion(db, sid, study.view_id, session);
  const { source: _source, preparation_sha256: _hash, generation_enabled: _enabled, status: _status, ...preparation } = prepared;
  if (prepared.preparation_sha256 !== study.preparation_sha256 || !isDeepStrictEqual(preparation, study.preparation)
    || prepared.source.image.sha256 !== study.source.image.sha256 || prepared.source.image.asset_id !== study.source.image.asset_id)
    throw new CreatorError("Motion source is historical. Prepare the current scene.", 409);
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${study.view_id}`, session_id: sid }, options);
  if (!view || (view.accepted_illustration_id ?? null) !== study.source.image.asset_id) throw new CreatorError("Accepted motion source changed", 409);
  return { study, view };
}
export async function motionSourceImage(study: MotionStudyDoc) {
  const source = study.source.image, stored = await getStoredBytes(source.key, AbortSignal.timeout(30_000));
  if (!stored || stored.bytes.length !== source.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== source.sha256)
    throw new CreatorError("Motion source bytes unavailable or corrupted", 503);
  const bytes = stored.bytes;
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 1024 * 1024 }).metadata();
    if (bytes.length > 4 * 1024 * 1024 || !["png", "jpeg"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1
      || (metadata.orientation ?? 1) !== 1 || metadata.width !== study.source.view.width || metadata.height !== study.source.view.height)
      throw new Error("Source image differs");
    if (metadata.width < 32 || metadata.height < 32 || metadata.width > 1024 || metadata.height > 1024)
      throw new Error("Source image dimensions unsupported");
    await sharp(bytes, { limitInputPixels: 1024 * 1024 }).raw().toBuffer();
    return { url: `data:image/${metadata.format};base64,${bytes.toString("base64")}`, sha256: source.sha256, bytes: source.bytes,
      width: study.source.view.width, height: study.source.view.height };
  } catch { throw new CreatorError("Unsupported motion source image", 409); }
}
