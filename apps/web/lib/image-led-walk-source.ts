import sharp from "sharp";
import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import type { Entity, EntityBBox, WorldEntityGeo } from "@openflipbook/config";
import type { NodeDoc } from "./db";
import { CreatorError } from "./creator-error";
import { getStoredBytes, uploadJpeg } from "./r2";
import { isSafeId } from "./ids";
import type { ImageLedImage, ImageLedLandmark, ImageLedSource, ImageLedWalkCreate, ImageLedWalkDoc } from "./image-led-walk";
import { IMAGE_LED_MAP_FRAME } from "./image-led-walk";

export const imageLedHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const imageLedBytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const IMAGE_LED_IMAGE_LIMIT = 12 * 1024 * 1024;
export const imageLedUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function fail(message: string, status = 409): never { throw new CreatorError(message, status); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundsValid = (b: unknown): b is ImageLedSource["map_frame"]["bounds"] => object(b) && [b.x, b.y, b.w, b.h].every(n => typeof n === "number" && Number.isFinite(n)) && Number(b.w) > 0 && Number(b.h) > 0;

export function parseImageLedCreate(value: Record<string, unknown>): ImageLedWalkCreate {
  if (Object.keys(value).some(key => !["id", "source_node_id", "map_frame", "points", "landmark_ids", "prompt", "seed", "landmark_crops"].includes(key))) fail("Unknown image-led route field", 400);
  if (!imageLedUuid(value.id) || !isSafeId(value.source_node_id) || !object(value.map_frame) || !boundsValid(value.map_frame.bounds)
    || value.map_frame.parent_id !== null && !isSafeId(value.map_frame.parent_id)) fail("Invalid route identity or source map frame", 400);
  if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > 12) fail("Use 2 to 12 map checkpoints", 400);
  const points = value.points.map(p => {
    if (!object(p) || Object.keys(p).some(k => !["x", "y"].includes(k)) || ![p.x, p.y].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) fail("Checkpoints must lie inside the original image", 400);
    return { x: Number(p.x), y: Number(p.y) };
  });
  if (points.some((p, i) => i > 0 && Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) < .001)) fail("Adjacent checkpoints must be distinct", 400);
  if (!Array.isArray(value.landmark_ids) || value.landmark_ids.length < 1 || value.landmark_ids.length > 8 || !value.landmark_ids.every(isSafeId) || new Set(value.landmark_ids).size !== value.landmark_ids.length) fail("Choose 1 to 8 distinct saved landmarks", 400);
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length > 1024 || value.prompt.trim().length > 0 && value.prompt.trim().length < 3)) fail("Keep the appearance description within 1024 characters", 400);
  let seed: ImageLedWalkCreate["seed"];
  if (value.seed !== undefined) {
    if (!object(value.seed) || Object.keys(value.seed).some(k => !["view_id", "asset_id", "sha256"].includes(k)) || !isSafeId(value.seed.view_id) || !isSafeId(value.seed.asset_id) || typeof value.seed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.seed.sha256)) fail("Invalid reviewed starting artwork", 400);
    seed = { view_id: String(value.seed.view_id), asset_id: String(value.seed.asset_id), sha256: String(value.seed.sha256) };
  }
  const landmarkIds = value.landmark_ids as string[];
  let landmark_crops: ImageLedWalkCreate["landmark_crops"];
  if (value.landmark_crops !== undefined) {
    if (!Array.isArray(value.landmark_crops) || value.landmark_crops.length > 8) fail("Invalid source crop review", 400);
    const seen = new Set<string>();
    landmark_crops = value.landmark_crops.map(row => {
      if (!object(row) || Object.keys(row).some(k => !["id", "x", "y", "w", "h", "confirmed"].includes(k)) || typeof row.id !== "string" || !landmarkIds.includes(row.id) || seen.has(row.id) || row.confirmed !== true
        || ![row.x, row.y, row.w, row.h].every(n => typeof n === "number" && Number.isFinite(n)) || Number(row.x) < 0 || Number(row.y) < 0 || Number(row.w) <= 0 || Number(row.h) <= 0 || Number(row.x) + Number(row.w) > 1 || Number(row.y) + Number(row.h) > 1) fail("Review a valid source-image crop for each landmark", 400);
      seen.add(row.id); return { id: row.id, x: Number(row.x), y: Number(row.y), w: Number(row.w), h: Number(row.h), confirmed: true as const };
    });
  }
  return { id: String(value.id), source_node_id: String(value.source_node_id), map_frame: { bounds: { ...value.map_frame.bounds }, parent_id: value.map_frame.parent_id as string | null }, points, landmark_ids: value.landmark_ids as string[], ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}), ...(seed ? { seed } : {}), ...(landmark_crops ? { landmark_crops } : {}) };
}

export async function readImageLedImage(key: string, expected?: Pick<ImageLedImage, "sha256" | "bytes">) {
  const stored = await getStoredBytes(key, AbortSignal.timeout(30_000));
  if (!stored || !stored.bytes.length || stored.bytes.length > IMAGE_LED_IMAGE_LIMIT) fail("Source artwork is unavailable or exceeds 12 MiB", 503);
  const bytes = stored.bytes, hash = imageLedBytesHash(bytes);
  if (expected && (hash !== expected.sha256 || bytes.length !== expected.bytes)) fail("Saved artwork bytes changed", 409);
  const decoder = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: "warning" }), info = await decoder.metadata();
  if (!["png", "jpeg"].includes(info.format ?? "") || !info.width || !info.height || info.width < 32 || info.height < 32 || info.width > 4096 || info.height > 4096 || (info.pages ?? 1) !== 1 || (info.orientation ?? 1) !== 1) fail("Artwork must be one upright PNG or JPEG", 409);
  await decoder.stats();
  const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] !== 255) fail("Source artwork must be opaque", 409);
  const image: ImageLedImage = { key, sha256: hash, bytes: bytes.length, width: info.width, height: info.height, content_type: info.format === "png" ? "image/png" : "image/jpeg" };
  return { image, bytes, url: `data:${image.content_type};base64,${bytes.toString("base64")}` };
}

interface WorldMapDoc { _id: string; entities: WorldEntityGeo[]; bounds: ImageLedSource["map_frame"]["bounds"] }
interface References { _id: string; session_id: string; source_sha256: string; source_width: number; source_height: number; reviewed_at: Date; landmarks: { label: string; left: number; top: number; width: number; height: number }[] }
interface Recipe { id: string; entity_id: string | null; label: string; visual: string; source_rectangle: ImageLedLandmark["source_rectangle"] | null; reference_kind: ImageLedLandmark["reference_kind"] | null }
async function sourceMetadata(db: Db, sid: string, nodeId: string, image: ImageLedImage, ids?: readonly string[], explicit?: ImageLedWalkCreate["landmark_crops"], session?: ClientSession) {
  const options = session ? { session } : {};
  if (!isSafeId(nodeId)) fail("Invalid source artwork", 400);
  const node = await db.collection<NodeDoc>("nodes").findOne({ _id: nodeId, session_id: sid }, options);
  const map = await db.collection<WorldMapDoc>("world_map").findOne({ _id: sid }, options);
  if (!node?.image_key || !map || !boundsValid(map.bounds) || node.scene_view && (node.scene_view.level !== "map" || node.scene_view.observer)) fail("Choose an owned map artwork and its saved map frame", 409);
  if (node.image_key !== image.key) fail("Source image changed", 409);
  const frame = { bounds: node.scene_view?.map_crop ?? map.bounds, parent_id: node.scene_view?.focus_id ?? null };
  if (!boundsValid(frame.bounds)) fail("The source map frame is unavailable", 409);
  const registry = await db.collection<{ _id: string; entities: Entity[] }>("world_state").findOne({ _id: sid }, options);
  const references = await db.collection<References>("source_landmark_references").find({ session_id: sid, source_sha256: image.sha256 }, options).limit(33).toArray();
  if (references.length > 32) fail("Source reference inventory is ambiguous", 409);
  const geos = map.entities.filter(g => (g.parent_id ?? null) === frame.parent_id), selected = ids ? ids.map(id => geos.find(g => g.id === id || g.entity_id === id) ?? fail("Landmark is outside this source map frame", 409)) : geos.slice(0, 64);
  if (new Set(selected.map(g => g.id)).size !== selected.length) fail("Landmark aliases select the same entity twice", 400);
  const recipes: Recipe[] = selected.map(geo => {
    const entity = registry?.entities.find(e => e.id === geo.entity_id), label = geo.label.trim(), visual = geo.visual?.trim() || entity?.appearance?.trim() || label;
    if (!label || label.length > 160 || visual.length > 1024) fail("Saved landmark description is invalid", 409);
    const chosen = explicit?.find(row => row.id === geo.id || row.id === geo.entity_id);
    let rectangle: Recipe["source_rectangle"] = null, kind: Recipe["reference_kind"] = null;
    const refs = references.filter(r => r.source_width === image.width && r.source_height === image.height && r.reviewed_at).flatMap(r => r.landmarks).filter(r => r.label === label || entity?.aliases?.includes(r.label));
    if (chosen) { rectangle = bboxRectangle({ x_pct: chosen.x, y_pct: chosen.y, w_pct: chosen.w, h_pct: chosen.h }, image); kind = "owner_reviewed_crop"; }
    else if (refs.length) {
      if (refs.some(r => imageLedHash(r) !== imageLedHash(refs[0]))) fail("Multiple source crop references disagree", 409);
      rectangle = { left: refs[0]!.left, top: refs[0]!.top, width: refs[0]!.width, height: refs[0]!.height }; kind = "reviewed_source_crop";
    } else if (geo.identity_anchor?.node_id === nodeId && geo.identity_anchor.image_key === node.image_key) { rectangle = bboxRectangle(geo.identity_anchor.bbox, image); kind = "identity_anchor"; }
    else if (entity?.appearance_bboxes[nodeId]) { rectangle = bboxRectangle(entity.appearance_bboxes[nodeId]!, image); kind = "appearance_bbox"; }
    if (rectangle && (![rectangle.left, rectangle.top, rectangle.width, rectangle.height].every(Number.isSafeInteger) || rectangle.left < 0 || rectangle.top < 0 || rectangle.width < 32 || rectangle.height < 32 || rectangle.left + rectangle.width > image.width || rectangle.top + rectangle.height > image.height)) fail("Source crop lies outside its original bytes", 409);
    return { id: geo.id, entity_id: geo.entity_id, label, visual, source_rectangle: rectangle, reference_kind: kind };
  });
  if (ids && new Set(recipes.map(r => r.label.normalize("NFKC").toLowerCase())).size !== recipes.length) fail("Choose landmarks with distinct saved names", 409);
  const binding = { node_id: nodeId, image_key: node.image_key, map_frame: frame, image_sha256: image.sha256, scene_view: node.scene_view ?? null, landmarks: recipes };
  const source: ImageLedSource = { node_id: nodeId, image_key: node.image_key, image: image, map_frame: frame, source_projection: "illustrated_oblique_or_unknown", binding_sha256: imageLedHash(binding) };
  return { node, map, source, recipes, references, registry };
}
export async function imageLedSourceContext(db: Db, sid: string, nodeId: string, ids?: readonly string[], explicit?: ImageLedWalkCreate["landmark_crops"]) {
  const node = await db.collection<NodeDoc>("nodes").findOne({ _id: nodeId, session_id: sid });
  if (!node?.image_key) fail("Owned source map unavailable", 404);
  const read = await readImageLedImage(node.image_key);
  return { ...await sourceMetadata(db, sid, nodeId, read.image, ids, explicit), bytes: read.bytes };
}
function bboxRectangle(box: EntityBBox, image: Pick<ImageLedImage, "width" | "height">) {
  if (![box.x_pct, box.y_pct, box.w_pct, box.h_pct].every(Number.isFinite) || box.x_pct < 0 || box.y_pct < 0 || box.w_pct <= 0 || box.h_pct <= 0 || box.x_pct + box.w_pct > 1 || box.y_pct + box.h_pct > 1) fail("Invalid saved source-image crop", 409);
  const precise = (n: number) => Math.abs(n - Math.round(n)) < 1e-8 ? Math.round(n) : n;
  const left = Math.floor(precise(box.x_pct * image.width)), top = Math.floor(precise(box.y_pct * image.height));
  return { left, top, width: Math.ceil(precise((box.x_pct + box.w_pct) * image.width)) - left, height: Math.ceil(precise((box.y_pct + box.h_pct) * image.height)) - top };
}
export async function prepareImageLedLandmarks(sid: string, context: Awaited<ReturnType<typeof imageLedSourceContext>>) {
  const landmarks: ImageLedLandmark[] = [];
  for (const recipe of context.recipes) {
    if (!recipe.source_rectangle || !recipe.reference_kind) fail(`Review a whole-building source crop for ${recipe.label}`, 409);
    const bytes = await sharp(context.bytes).extract(recipe.source_rectangle).flatten({ background: "#ffffff" }).toColourspace("srgb").png().toBuffer();
    const key = `${sid}/image-led/references/${imageLedBytesHash(bytes)}.png`, info = await sharp(bytes).metadata();
    if (bytes.length > IMAGE_LED_IMAGE_LIMIT) fail("Source crop exceeds its byte limit", 413);
    await uploadJpeg(key, bytes, "image/png", AbortSignal.timeout(60_000));
    landmarks.push({ ...recipe, source_rectangle: recipe.source_rectangle, reference_kind: recipe.reference_kind, image: { key, sha256: imageLedBytesHash(bytes), bytes: bytes.length, width: info.width!, height: info.height!, content_type: "image/png" } });
  }
  return landmarks;
}
export async function requireImageLedCurrent(db: Db, walk: ImageLedWalkDoc) {
  const explicit = walk.landmarks.filter(l => l.reference_kind === "owner_reviewed_crop").map(l => ({ id: l.id, x: l.source_rectangle.left / walk.source.image.width, y: l.source_rectangle.top / walk.source.image.height, w: l.source_rectangle.width / walk.source.image.width, h: l.source_rectangle.height / walk.source.image.height, confirmed: true as const }));
  const context = await imageLedSourceContext(db, walk.session_id, walk.source.node_id, walk.landmarks.map(l => l.id), explicit);
  if (context.source.binding_sha256 !== walk.source.binding_sha256 || imageLedHash(context.source) !== imageLedHash(walk.source)) fail("Source map, frame or landmark identity changed. Saved work remains preserved.", 409);
  for (const landmark of walk.landmarks) await readImageLedImage(landmark.image.key, landmark.image);
  return context;
}
/** Serialize changes to source metadata with the transaction's generation claim/review. No image/geometry changes. */
export async function fenceImageLedSource(db: Db, session: ClientSession, walk: ImageLedWalkDoc) {
  const explicit = walk.landmarks.filter(l => l.reference_kind === "owner_reviewed_crop").map(l => ({ id: l.id, x: l.source_rectangle.left / walk.source.image.width, y: l.source_rectangle.top / walk.source.image.height, w: l.source_rectangle.width / walk.source.image.width, h: l.source_rectangle.height / walk.source.image.height, confirmed: true as const }));
  const value = await sourceMetadata(db, walk.session_id, walk.source.node_id, walk.source.image, walk.landmarks.map(l => l.id), explicit, session), options = { session };
  if (imageLedHash(value.source) !== imageLedHash(walk.source)) fail("Source map frame, identity or references changed", 409);
  await db.collection<NodeDoc>("nodes").updateOne({ _id: value.node._id, session_id: walk.session_id }, { $inc: { image_led_fence: 1 } }, options);
  await db.collection<WorldMapDoc>("world_map").updateOne({ _id: walk.session_id }, { $inc: { image_led_fence: 1 } }, options);
  if (value.registry) await db.collection<{ _id: string }>("world_state").updateOne({ _id: walk.session_id }, { $inc: { image_led_fence: 1 } }, options);
  for (const row of value.references) await db.collection<References>("source_landmark_references").updateOne({ _id: row._id, source_sha256: walk.source.image.sha256 }, { $inc: { image_led_fence: 1 } }, options);
}
export const imageLedRoute = (points: ImageLedWalkCreate["points"], sourceSha: string) => ({ frame: IMAGE_LED_MAP_FRAME, points, map_sha256: sourceSha, sha256: imageLedHash({ frame: IMAGE_LED_MAP_FRAME, points, map_sha256: sourceSha }) });
