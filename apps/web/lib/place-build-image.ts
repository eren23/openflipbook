import sharp from "sharp";
import type { ClientSession, Db } from "mongodb";
import type { PlaceBuildImageReference } from "@openflipbook/config";
import type { NodeDoc } from "./db";
import type { SceneDoc } from "./place-scene-store";
import { CreatorError } from "./creator-error";
import { getStoredBytes } from "./r2";
import { createHash } from "node:crypto";

export interface BuildImageInput extends PlaceBuildImageReference { source_image_key: string }
export const MAX_BUILD_IMAGE_BYTES = 12 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function wireBuildImage({ source_image_key: _key, ...reference }: BuildImageInput): PlaceBuildImageReference { return reference; }

async function imageBytes(key: string) {
  const stored = await getStoredBytes(key, AbortSignal.timeout(30_000));
  if (!stored) throw new CreatorError("Saved layout reference image unavailable. No provider call was submitted.", 503);
  const bytes = stored.bytes;
  if (!bytes.length || bytes.length > MAX_BUILD_IMAGE_BYTES) throw new CreatorError("Layout reference image exceeds 12 MiB", 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" }), metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 || metadata.width > 4096 || metadata.height > 4096
      || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1) throw new Error("Unsupported source image");
    await image.stats();
    return { bytes, width: metadata.width, height: metadata.height, content_type: `image/${metadata.format}` as PlaceBuildImageReference["content_type"] };
  } catch { throw new CreatorError("Layout reference must be one PNG, JPEG or WebP frame, 32–4096px, without rotation metadata", 400); }
}

export async function pinBuildImage(db: Db, sid: string, pid: string, revision: number): Promise<BuildImageInput> {
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}`, session_id: sid });
  if (!scene || scene.revision !== revision || !scene.source_node_id || !scene.source_image_key) throw new CreatorError("Save an image-bound place and its authored dimensions before image layout generation", 409);
  const node = await db.collection<NodeDoc>("nodes").findOne({ _id: scene.source_node_id, session_id: sid });
  if (!node || node.image_key !== scene.source_image_key) throw new CreatorError("Saved layout reference binding changed", 409);
  const source = await imageBytes(scene.source_image_key);
  return { source_node_id: scene.source_node_id, source_image_key: scene.source_image_key, sha256: sha256(source.bytes), bytes: source.bytes.length,
    width: source.width, height: source.height, content_type: source.content_type,
    registration: { scene_id: scene.id, base_revision: scene.revision, width_metres: scene.definition.width, depth_metres: scene.definition.depth,
      coordinate_frame: "authored_metres", geometry: "estimated_proposal" } };
}

export async function requireBuildImageCurrent(db: Db, sid: string, pid: string, input: BuildImageInput, session?: ClientSession) {
  const options = session ? { session } : {};
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}`, session_id: sid }, options);
  const node = await db.collection<NodeDoc>("nodes").findOne({ _id: input.source_node_id, session_id: sid }, options);
  if (!scene || !node || scene.source_node_id !== input.source_node_id || scene.source_image_key !== input.source_image_key || node.image_key !== input.source_image_key
    || scene.id !== input.registration.scene_id || scene.revision !== input.registration.base_revision
    || scene.definition.width !== input.registration.width_metres || scene.definition.depth !== input.registration.depth_metres)
    throw new CreatorError("Layout image or authored registration changed. No provider call was submitted.", 409);
}

export async function prepareBuildImage(db: Db, sid: string, pid: string, input: BuildImageInput) {
  await requireBuildImageCurrent(db, sid, pid, input);
  const source = await imageBytes(input.source_image_key);
  if (sha256(source.bytes) !== input.sha256 || source.bytes.length !== input.bytes || source.width !== input.width || source.height !== input.height || source.content_type !== input.content_type)
    throw new CreatorError("Saved layout image bytes changed. No provider call was submitted.", 409);
  await requireBuildImageCurrent(db, sid, pid, input);
  return { ...wireBuildImage(input), data_url: `data:${source.content_type};base64,${source.bytes.toString("base64")}` };
}
