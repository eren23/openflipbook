import sharp from "sharp";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { CreatorError } from "./creator-error";
import type { KeyframeReferencePreparation, SourceArtworkLandmark } from "./place-view";

export interface LandmarkReferenceDoc {
  _id: string; session_id: string; place_id: string; source_sha256: string;
  source_width: number; source_height: number; landmarks: SourceArtworkLandmark[]; reviewed_at: Date;
}
export function validateLandmarkReferences(input: unknown, width: number, height: number, labels: string[]): SourceArtworkLandmark[] {
  if (!Array.isArray(input) || input.length !== 4) throw new CreatorError("Review four original building references.", 400);
  const allowed = new Set(labels), seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CreatorError("Invalid building reference.", 400);
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(k => !["label", "left", "top", "width", "height"].includes(k)) || typeof row.label !== "string" || !allowed.has(row.label) || seen.has(row.label))
      throw new CreatorError("Building reference identity is missing, duplicated or not in this saved place.", 400);
    seen.add(row.label);
    const values = [row.left, row.top, row.width, row.height];
    if (!values.every(n => typeof n === "number" && Number.isInteger(n))) throw new CreatorError("Building references need integer source-image rectangles.", 400);
    const [left, top, w, h] = values as number[];
    if (left! < 0 || top! < 0 || w! < 32 || h! < 32 || left! + w! > width || top! + h! > height)
      throw new CreatorError("Building reference lies outside the original source image.", 400);
    return { label: row.label, left: left!, top: top!, width: w!, height: h! };
  });
}
export async function sourceLandmarkReferences(db: Db, sid: string, placeId: string, sourceSha: string, labels: string[]) {
  const record = await db.collection<LandmarkReferenceDoc>("source_landmark_references").findOne({ _id: `${sid}:${placeId}:${sourceSha}`, session_id: sid, place_id: placeId, source_sha256: sourceSha });
  if (!record) throw new CreatorError("Review four building crops from the original map before generating a street keyframe.", 409);
  return validateLandmarkReferences(record.landmarks, record.source_width, record.source_height, labels);
}
/** Full map plus separately named whole-building crops, all from the same original bytes. */
export async function prepareKeyframeMapReference(bytes: Buffer, landmarks: SourceArtworkLandmark[]) {
  const image = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: "error" }), metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.orientation && metadata.orientation !== 1)
    throw new CreatorError("Map references need one unrotated source image.", 409);
  const checked = validateLandmarkReferences(landmarks, metadata.width, metadata.height, landmarks.map(l => l.label));
  const full = await sharp(bytes).flatten({ background: "#ffffff" }).toColourspace("srgb").resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const fullSize = await sharp(full).metadata(), hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const crops = await Promise.all(checked.map(async l => {
    const png = await sharp(bytes).extract({ left: l.left, top: l.top, width: l.width, height: l.height })
      .flatten({ background: "#ffffff" }).toColourspace("srgb").resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const size = await sharp(png).metadata();
    return { png, proof: { ...l, sha256: hash(png), output_width: size.width!, output_height: size.height! } };
  }));
  const reference_preparation: KeyframeReferencePreparation = { version: "source-art-map-landmarks-v1", source_sha256: hash(bytes), sha256: hash(full),
    source_width: metadata.width, source_height: metadata.height, width: fullSize.width!, height: fullSize.height!, tile_size: 0, gutter: 0, crops: [], landmarks: crops.map(c => c.proof) };
  return { reference_url: `data:image/png;base64,${full.toString("base64")}`, landmark_urls: crops.map(c => `data:image/png;base64,${c.png.toString("base64")}`), landmark_labels: checked.map(c => c.label), reference_preparation };
}
