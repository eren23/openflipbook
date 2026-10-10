import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { getStoredBytes } from "./r2";
import type { ClientSession, Db } from "mongodb";
import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import { reserveGenerationSpend } from "./generation-reservation";
import { modalAuthHeaders, modalUrl } from "./modal";
import { type PlaceViewDoc } from "./place-view-store";
import type { MeshAssetDoc } from "./mesh-docs";
import { reviewedKeyframe } from "./illustration-verification";
import { illustrationDependency } from "./illustration-input";
import { verified } from "./motion-execution";
import { isSafeId } from "./ids";
import { imageLedHash, imageLedSourceContext, imageLedUuid, parseImageLedCreate, prepareImageLedLandmarks, readImageLedImage, requireImageLedCurrent, fenceImageLedSource, imageLedRoute } from "./image-led-walk-source";
import { IMAGE_LED_WALK_PROFILE, type ImageLedFile, type ImageLedImage, type ImageLedRepair, type ImageLedSeed, type ImageLedWalkDoc, type ImageLedWalkQuote, type ImageLedWalkWire, type ImageLedStepStatus } from "./image-led-walk";
import { imageLedRouteIntent } from "./image-led-route-intent";
import { IMAGE_LED_STILL_PROFILES, imageLedStillProfile, validateImageLedStillInputs } from "./image-led-walk-profiles";
import { imageLedBytesHash, IMAGE_LED_IMAGE_LIMIT } from "./image-led-walk-source";
import { imageLedPlayback } from "./image-led-walk-playback";

export const IMAGE_LED_MODEL = "fal-ai/nano-banana-pro/edit";
export const IMAGE_LED_VIDEO_MODEL = "minimax/h3-max/image-to-video";
export const IMAGE_LED_PARAMETERS = IMAGE_LED_STILL_PROFILES[IMAGE_LED_MODEL].parameters;
export const IMAGE_LED_VIDEO_PARAMETERS = { duration: 3, resolution: "768P", prompt_expansion_mode: "disabled", enable_safety_checker: true, sync_mode: false, prompt_version: "image-led-walk-video-v4" };
export interface ImageLedStepDoc { _id: string; id: string; session_id: string; walk_id: string; kind: "still" | "video"; index: number; status: ImageLedStepStatus; request_sha256: string; quote: ImageLedWalkQuote; input_sha256: string; ledger_ids: string[]; created_at: Date; updated_at: Date; provider_request_id?: string; provider_input_sha256?: string; provider_result?: Record<string, unknown>; submission_started_at?: Date; submission_deadline?: Date; work_token?: string; work_until?: Date; next_check?: Date; original?: ImageLedImage | ImageLedFile; error?: string; reservation_released?: boolean }
function fail(message: string, status = 409): never { throw new CreatorError(message, status); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class ImageLedBackendError extends Error { constructor(public status: number, public receipt: Record<string, unknown>) { super("Image-led backend acknowledgement unavailable"); } }
/** One fetch, no submission retry; errors retain a bounded known request receipt. */
export async function imageLedBackend(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!process.env.MODAL_API_URL) fail("Image-led backend is unavailable", 503);
  const response = await fetch(modalUrl(process.env.MODAL_API_URL, `/image-led-walk/${path}`), { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", headers: { "Content-Type": "application/json", ...modalAuthHeaders() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(body === undefined ? 90_000 : 120_000) });
  if (!response.body) throw new ImageLedBackendError(response.status, {});
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100_000) { await reader.cancel(); throw new Error("Image-led acknowledgement exceeds limit"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ImageLedBackendError(response.status, {}); }
  if (!object(value)) throw new ImageLedBackendError(response.status, {});
  if (!response.ok) throw new ImageLedBackendError(response.status, value);
  return value;
}
export async function imageLedCapabilities(db: Db, kind: "still" | "video", session?: ClientSession) {
  const value = await imageLedBackend(kind === "still" ? "capabilities" : "video/capabilities");
  let model = IMAGE_LED_VIDEO_MODEL, parameters = IMAGE_LED_VIDEO_PARAMETERS as Record<string, unknown>;
  if (kind === "still") { try { const selected = imageLedStillProfile(value.model, value.parameters); model = selected.model; parameters = selected.parameters; } catch { fail("Image-led model or current price is unavailable", 503); } }
  const reservation = value.reservation;
  if (value.enabled !== true || value.profile !== IMAGE_LED_WALK_PROFILE || value.model !== model || !isDeepStrictEqual(value.parameters, parameters) || typeof reservation !== "number" || !Number.isFinite(reservation) || reservation < (kind === "still" ? .15 : .24) || reservation > 2.5) fail("Image-led model or current price is unavailable", 503);
  const fresh = { kind: "place-layout", last_seen: { $gt: new Date(Date.now() - 30_000) } }, flag = kind === "still" ? "image_led_walk_v4_canvas_v1" : "image_led_walk_video_v4", lane = kind === "still" ? "mesh" : "motion", options = session ? { session } : {};
  if (kind === "video" && process.env.PATH_VIDEO_ENABLED !== "1") fail("Image-led walk videos are disabled", 503);
  if (await db.collection("generation_workers").findOne({ ...fresh, [lane]: true, [flag]: { $ne: true } }, options) || !await db.collection("generation_workers").findOne({ ...fresh, [flag]: true }, options)) fail("Compatible image-led worker unavailable", 503);
  return { model, parameters, reservation };
}
export async function imageLedSeed(db: Db, sid: string, input: Pick<ImageLedSeed, "view_id" | "asset_id" | "sha256">, sourceSha: string, session?: ClientSession) {
  const options = session ? { session } : {}, view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${input.view_id}`, session_id: sid }, options), asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${input.asset_id}`, session_id: sid }, options);
  if (!view || view.walk_checkpoint || view.accepted_illustration_id !== input.asset_id || !asset || asset.sha256 !== input.sha256 || !isDeepStrictEqual(asset.view_dependency, illustrationDependency(view)) || !reviewedKeyframe(asset.keyframe, asset.sha256) || asset.keyframe?.reference_preparation?.source_sha256 !== sourceSha) fail("Choose a currently selected, reviewed artwork of this exact source map", 409);
  const read = await readImageLedImage(asset.key, { sha256: asset.sha256, bytes: asset.bytes });
  if (asset.keyframe.final_image?.width !== read.image.width || asset.keyframe.final_image.height !== read.image.height) fail("Reviewed starting image dimensions changed");
  const seed: ImageLedSeed = { view_id: view.id, asset_id: asset.id, sha256: asset.sha256, review_sha256: imageLedHash(asset.keyframe.content_approval), image: read.image };
  if (session) { if (!(await db.collection<PlaceViewDoc>("place_views").updateOne({ _id: view._id, accepted_illustration_id: asset.id }, { $inc: { source_use_fence: 1 } }, options)).matchedCount) fail("Reviewed artwork selection changed"); await db.collection<MeshAssetDoc>("illustration_assets").updateOne({ _id: asset._id, sha256: asset.sha256 }, { $inc: { image_led_fence: 1 } }, options); }
  return seed;
}
export function imageLedEligible(walk: ImageLedWalkDoc, kind: "still" | "video", index: number) {
  if (walk.status === "archived" || walk.archive_provenance) fail("Imported image-led walks are preserved for review and playback only");
  const slots = kind === "still" ? walk.frames : walk.legs;
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) fail("Checkpoint is unavailable", 400);
  const slot = slots[index]!;
  if (slot.job_id || slot.status !== "empty") fail("This checkpoint already has a request; check its saved receipt instead");
  if ([...walk.frames, ...walk.legs].some(s => !["empty", "ready"].includes(s.status))) fail("Resolve the existing submission before generating another step");
  const approved = (i: number) => { const f = walk.frames[i]; return !!f?.image && f.status === "ready" && f.review.sha256 === f.image.sha256 && f.review.identity === "approved" && f.review.route === "approved"; };
  if (kind === "still") { if (walk.frames.slice(0, index).some((_, i) => !approved(i)) || walk.frames.slice(index + 1).some(f => f.status !== "empty")) fail("Review each preceding artwork before continuing the route"); }
  else { if (walk.frames.some((_, i) => !approved(i))) fail("Review identity and route placement for every artwork before creating clips"); if (walk.legs.slice(0, index).some(l => !l.video || l.status !== "ready" || l.review.temporal !== "approved" || l.review.sha256 !== l.video.sha256) || walk.legs.slice(index + 1).some(l => l.status !== "empty")) fail("Review each earlier clip before continuing; segments cannot be skipped"); }
}
function repairDescriptor(value: unknown, sid: string): ImageLedImage {
  if (!object(value) || Object.keys(value).some(k => !["key", "sha256", "bytes", "width", "height", "content_type"].includes(k)) || typeof value.key !== "string" || !value.key.startsWith(`${sid}/image-led/`) || value.key.includes("..") || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !["image/png", "image/jpeg"].includes(String(value.content_type)) || ![value.bytes, value.width, value.height].every(n => Number.isInteger(n) && Number(n) > 0) || Number(value.bytes) > IMAGE_LED_IMAGE_LIMIT || Math.min(Number(value.width), Number(value.height)) < 32 || Math.max(Number(value.width), Number(value.height)) > 4096) fail("Repair images must be exact owned image-led PNG/JPEG files", 400);
  return { key: value.key, sha256: value.sha256, bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height), content_type: value.content_type as "image/png" | "image/jpeg" };
}
export function parseImageLedRepair(value: unknown, walk: ImageLedWalkDoc, index: number): ImageLedRepair | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(k => !["checkpoint_index", "source_sha256", "target_sha256", "image", "mask"].includes(k)) || value.checkpoint_index !== index || value.source_sha256 !== walk.source.image.sha256) fail("Repair provenance changed from the source or checkpoint", 409);
  const image = repairDescriptor(value.image, walk.session_id), mask = value.mask === undefined ? undefined : repairDescriptor(value.mask, walk.session_id);
  if (value.target_sha256 !== image.sha256 || mask && (mask.content_type !== "image/png" || mask.width !== image.width || mask.height !== image.height)) fail("Repair target hash or mask dimensions changed", 409);
  return { checkpoint_index: index, source_sha256: walk.source.image.sha256, target_sha256: image.sha256, image, ...(mask ? { mask } : {}) };
}
async function repairMaskDescriptor(mask: ImageLedImage) {
  const stored = await getStoredBytes(mask.key, AbortSignal.timeout(30_000));
  if (!stored || stored.bytes.length !== mask.bytes || imageLedBytesHash(stored.bytes) !== mask.sha256) fail("Saved repair mask bytes changed", 409);
  const decoder = sharp(stored.bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: "warning" }), info = await decoder.metadata();
  if (info.format !== "png" || info.width !== mask.width || info.height !== mask.height || (info.pages ?? 1) !== 1 || (info.orientation ?? 1) !== 1) fail("Repair mask must be one upright PNG matching its exact target", 409);
  await decoder.stats();
  const { key: _key, content_type: _mime, ...fields } = mask;
  return { ...fields, url: `data:image/png;base64,${stored.bytes.toString("base64")}` };
}
export async function imageLedInputs(db: Db, walk: ImageLedWalkDoc, kind: "still" | "video", index: number, cap: Awaited<ReturnType<typeof imageLedCapabilities>>, repairInput?: ImageLedRepair) {
  const repair = parseImageLedRepair(repairInput, walk, index);
  if (repair && kind !== "still") fail("Video requests do not support repair inputs", 400);
  const parent = index > 0 ? walk.frames[index - 1]?.image : walk.seed?.image;
  if (kind === "still") validateImageLedStillInputs(cap.model, cap.parameters, [...(repair ? [repair.image] : []), ...(parent ? [parent] : []), walk.source.image, ...walk.landmarks.map(l => l.image)], repair);
  imageLedEligible(walk, kind, index); const context = await requireImageLedCurrent(db, walk);
  if (repair && !await db.collection<ImageLedStepDoc>("image_led_walk_steps").findOne({ session_id: walk.session_id, kind: "still", index, "original.key": repair.image.key, "original.sha256": repair.target_sha256, "original.bytes": repair.image.bytes, "quote.source_sha256": walk.source.image.sha256, "quote.binding_sha256": walk.source.binding_sha256, "quote.route_sha256": walk.route.sha256 })) fail("Repair target lacks a saved receipt for this exact source, route and checkpoint", 409);
  if (walk.seed && imageLedHash(await imageLedSeed(db, walk.session_id, walk.seed, walk.source.image.sha256)) !== imageLedHash(walk.seed)) fail("Starting artwork changed");
  const descriptor = async (image: ImageLedImage) => { const read = await readImageLedImage(image.key, image); if (read.image.width !== image.width || read.image.height !== image.height || read.image.content_type !== image.content_type) fail("Saved image dimensions or format changed"); const { key: _key, content_type: _mime, ...fields } = image; return { ...fields, url: read.url }; };
  const source = await descriptor(walk.source.image), route = { frame: walk.route.frame, points: walk.route.points, checkpoint_index: index, map_sha256: walk.source.image.sha256 };
  const route_intent = imageLedRouteIntent({ source: walk.source.image, points: walk.route.points, landmarks: walk.landmarks, checkpointIndex: index });
  let body: Record<string, unknown>;
  if (kind === "still") {
    const landmarks = await Promise.all(walk.landmarks.map(async l => ({ id: l.id, label: l.label, visual: l.visual, source_rectangle: l.source_rectangle, image: await descriptor(l.image) })));
    body = { profile: IMAGE_LED_WALK_PROFILE, ...cap, prompt: walk.prompt, source_projection: context.source.source_projection, source, landmarks, route, route_intent, ...(parent ? { prior: { checkpoint_index: index ? index - 1 : 0, reviewed_sha256: parent.sha256, image: await descriptor(parent) } } : {}), ...(repair ? { repair: { ...repair, image: await descriptor(repair.image), ...(repair.mask ? { mask: await repairMaskDescriptor(repair.mask) } : {}) } } : {}) };
  } else {
    const a = walk.frames[index]!.image!, b = walk.frames[index + 1]!.image!; if (a.width !== b.width || a.height !== b.height || a.bytes > 4 * 1024 * 1024 || b.bytes > 4 * 1024 * 1024 || a.sha256 === b.sha256) fail("Reviewed clip endpoints need distinct bounded images with the same dimensions");
    body = { profile: IMAGE_LED_WALK_PROFILE, ...cap, prompt: walk.prompt, source_sha256: walk.source.image.sha256, route, route_intent, landmarks: walk.landmarks.map(({ id, label, visual }) => ({ id, label, visual })), start: await descriptor(a), end: await descriptor(b) };
  }
  const playback = kind === "still" ? imageLedPlayback(walk) : undefined;
  const fingerprint = { source: walk.source, landmarks: walk.landmarks, route: walk.route, route_intent, prompt: walk.prompt, seed: walk.seed ?? null, kind, index, parent: index > 0 ? walk.frames[index - 1] : null, ...(kind === "video" ? { frames: walk.frames, prior_legs: walk.legs.slice(0, index) } : {}), model: cap.model, parameters: cap.parameters, reservation: cap.reservation, ...(repair ? { repair } : {}), ...(playback ? { playback } : {}) };
  return { body, sha256: imageLedHash(fingerprint), ...(playback ? { playback } : {}) };
}
export function imageLedWire(walk: ImageLedWalkDoc): ImageLedWalkWire {
  const base = `/api/world/${encodeURIComponent(walk.session_id)}/image-led-walks/${encodeURIComponent(walk.id)}/files`, image = ({ key: _key, ...v }: ImageLedImage) => v;
  const { _id, source, landmarks, frames, legs, seed, created_at, updated_at, ...rest } = walk;
  return { ...rest, created_at: created_at.toISOString(), updated_at: updated_at.toISOString(), source: { node_id: source.node_id, map_frame: source.map_frame, source_projection: source.source_projection, binding_sha256: source.binding_sha256, image: image(source.image), image_url: `${base}/source` }, landmarks: landmarks.map((l, i) => ({ ...l, image: image(l.image), image_url: `${base}/landmark-${i}` })), frames: frames.map(f => ({ ...f, ...(f.raw ? { raw: image(f.raw), raw_url: `${base}/raw-${f.index}` } : {}), ...(f.image ? { image: image(f.image), image_url: `${base}/frame-${f.index}` } : {}) })), legs: legs.map(l => { const { original, video, ...value } = l; return { ...value, ...(original ? { original: (({ key: _key, ...v }) => v)(original) } : {}), ...(video ? { video: (({ key: _key, ...v }) => v)(video), video_url: `${base}/video-${l.index}` } : {}) }; }), ...(seed ? { seed: { ...seed, image: image(seed.image) } } : {}) };
}
async function ownedWalk(db: Db, sid: string, id: string) { if (!isSafeId(id)) fail("Invalid walk id", 400); const walk = await db.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: `${sid}:${id}`, session_id: sid }); if (!walk) fail("Image-led walk not found", 404); return walk; }
export async function imageLedLibrary(sid: string, sourceNode?: string) {
  const db = await requireCreator(sid), walks = await db.collection<ImageLedWalkDoc>("image_led_walks").find({ session_id: sid, ...(sourceNode ? { "source.node_id": sourceNode } : {}) }).sort({ created_at: -1 }).limit(30).toArray();
  if (!sourceNode) return { walks: walks.map(imageLedWire) };
  const value = await imageLedSourceContext(db, sid, sourceNode), seeds = [];
  const views = await db.collection<PlaceViewDoc>("place_views").find({ session_id: sid, accepted_illustration_id: { $exists: true }, walk_checkpoint: { $ne: true } }).limit(100).toArray();
  for (const view of views) { try { const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${view.accepted_illustration_id}`, session_id: sid }); if (!asset) continue; const seed = await imageLedSeed(db, sid, { view_id: view.id, asset_id: asset.id, sha256: asset.sha256 }, value.source.image.sha256); seeds.push({ view_id: seed.view_id, asset_id: seed.asset_id, sha256: seed.sha256, label: view.label || `Reviewed artwork ${view.id}`, image_url: `/api/world/${sid}/illustrations/${asset.id}` }); } catch { /* Historical/unselected artwork is not a starting seed. */ } }
  const { key: _key, ...image } = value.source.image;
  return { walks: walks.map(imageLedWire), source: { node_id: sourceNode, map_frame: value.source.map_frame, image, image_url: `/api/world/${sid}/image-led-walks/source/${sourceNode}`, landmarks: value.recipes.map(r => ({ id: r.id, entity_id: r.entity_id, label: r.label, visual: r.visual, crop_available: !!r.source_rectangle, ...(r.source_rectangle ? { source_rectangle: r.source_rectangle } : {}) })), seeds } };
}
export async function createImageLedWalk(sid: string, input: Record<string, unknown>) {
  const db = await requireCreator(sid), body = parseImageLedCreate(input), requestHash = imageLedHash(body), key = `${sid}:${body.id}`, col = db.collection<ImageLedWalkDoc>("image_led_walks"), old = await col.findOne({ _id: key, session_id: sid });
  const same = (walk: ImageLedWalkDoc) => { if (walk.request_sha256 !== requestHash) fail("Walk request id already belongs to another source or route"); return { walk: imageLedWire(walk) }; }; if (old) return same(old);
  const context = await imageLedSourceContext(db, sid, body.source_node_id, body.landmark_ids, body.landmark_crops); if (!isDeepStrictEqual(context.source.map_frame, body.map_frame)) fail("Source map frame changed; reopen this artwork");
  const landmarks = await prepareImageLedLandmarks(sid, context), seed = body.seed ? await imageLedSeed(db, sid, body.seed, context.source.image.sha256) : undefined, now = new Date();
  const walk: ImageLedWalkDoc = { _id: key, id: body.id, session_id: sid, profile: IMAGE_LED_WALK_PROFILE, created_at: now, updated_at: now, request_sha256: requestHash, status: "draft", source: context.source, landmarks, route: imageLedRoute(body.points, context.source.image.sha256), prompt: body.prompt?.trim() || "Continue through this original illustrated world at street level, preserving its recognizable architecture and atmosphere.", ...(seed ? { seed } : {}), frames: body.points.map((_, index) => ({ index, status: index === 0 && seed ? "ready" : "empty", ...(index === 0 && seed ? { raw: seed.image, image: seed.image } : {}), review: { identity: "pending", route: "pending", spatial: "unmeasured", ...(index === 0 && seed ? { sha256: seed.sha256 } : {}) } })), legs: body.points.slice(1).map((_, index) => ({ index, from: index, to: index + 1, status: "empty", review: { temporal: "pending" } })), revision: 1 };
  return withDbTransaction(async (tx, session) => { const collection = tx.collection<ImageLedWalkDoc>("image_led_walks"), old = await collection.findOne({ _id: key }, { session }); if (old) return same(old); if (await collection.countDocuments({ session_id: sid }, { session }) >= 30) fail("This world already has 30 image-led routes"); await fenceImageLedSource(tx, session, walk); if (seed) await imageLedSeed(tx, sid, seed, walk.source.image.sha256, session); await collection.insertOne(walk, { session }); return { walk: imageLedWire(walk) }; });
}
export async function imageLedQuote(db: Db, walk: ImageLedWalkDoc, kind: "still" | "video", index: number, repairInput?: ImageLedRepair) {
  const repair = parseImageLedRepair(repairInput, walk, index);
  const cap = await imageLedCapabilities(db, kind), inputs = await imageLedInputs(db, walk, kind, index, cap, repair), quote = { version: 1 as const, profile: IMAGE_LED_WALK_PROFILE, kind, index, ...cap, retry_allowance: 0 as const, source_sha256: walk.source.image.sha256, binding_sha256: walk.source.binding_sha256, route_sha256: walk.route.sha256, inputs_sha256: inputs.sha256, spatial_validation: "unmeasured" as const, ...(repair ? { repair } : {}) };
  const prepared = { ...quote, ...(inputs.playback ? { playback: inputs.playback } : {}) };
  return { ...prepared, quote_sha256: imageLedHash(prepared) };
}
export async function imageLedDetail(sid: string, id: string, kind?: string, index?: number) {
  const db = await requireCreator(sid), walk = await ownedWalk(db, sid, id); let quote: ImageLedWalkQuote | null = null, reason: string | undefined;
  if (kind !== undefined) { if (!["still", "video"].includes(kind) || !Number.isInteger(index)) fail("Invalid quote checkpoint", 400); try { quote = await imageLedQuote(db, walk, kind as "still" | "video", index!); } catch (error) { reason = error instanceof CreatorError ? error.message : "Image-led quote unavailable"; } }
  return { walk: imageLedWire(walk), quote, ...(reason ? { reason } : {}) };
}
export async function imageLedAction(sid: string, id: string, input: Record<string, unknown>) {
  const db = await requireCreator(sid), walk = await ownedWalk(db, sid, id);
  if (input.action === "fork") return forkImageLedWalk(db, walk, input);
  if (input.action === "quote") {
    if (Object.keys(input).some(k => !["action", "kind", "index", "repair"].includes(k)) || !["still", "video"].includes(String(input.kind)) || !Number.isInteger(input.index)) fail("Invalid quote checkpoint", 400);
    const index = input.index as number, repair = parseImageLedRepair(input.repair, walk, index);
    const quote = await imageLedQuote(db, walk, input.kind as "still" | "video", index, repair);
    return { walk: imageLedWire(walk), quote };
  }
  if (input.action === "review") return reviewImageLedWalk(db, walk, input);
  if (input.action !== "schedule" || Object.keys(input).some(k => !["action", "id", "kind", "index", "quote", "confirmed"].includes(k)) || !imageLedUuid(input.id) || input.confirmed !== true || !["still", "video"].includes(String(input.kind)) || !Number.isInteger(input.index)) fail("Explicit current quote consent is required", 400);
  const key = `${sid}:${input.id}`, requestHash = imageLedHash(input), jobs = db.collection<ImageLedStepDoc>("image_led_walk_steps"), old = await jobs.findOne({ _id: key });
  const same = async (job: ImageLedStepDoc) => { if (job.walk_id !== id || job.request_sha256 !== requestHash) fail("Step request id already belongs to another action"); return { walk: imageLedWire(await ownedWalk(db, sid, id)) }; }; if (old) return same(old);
  const kind = input.kind as "still" | "video", index = input.index as number, repair = object(input.quote) ? parseImageLedRepair(input.quote.repair, walk, index) : undefined, quote = await imageLedQuote(db, walk, kind, index, repair); if (!isDeepStrictEqual(input.quote, quote)) fail("Artwork, review or price changed; review the current quote");
  return withDbTransaction(async (tx, session) => { const jobs = tx.collection<ImageLedStepDoc>("image_led_walk_steps"), options = { session }, old = await jobs.findOne({ _id: key }, options); if (old) { if (old.walk_id !== id || old.request_sha256 !== requestHash) fail("Step request id already belongs to another action"); return { walk: imageLedWire((await tx.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: walk._id }, options))!) }; }
    const current = await tx.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: walk._id, revision: walk.revision }, options); if (!current) fail("Walk review changed before scheduling"); imageLedEligible(current, kind, index); await fenceImageLedSource(tx, session, current); if (current.seed) await imageLedSeed(tx, sid, current.seed, current.source.image.sha256, session);
    const ledger_ids = await reserveGenerationSpend(tx, session, sid, kind === "still" ? "illustration" : "motion", quote.reservation, kind === "still" ? "ILLUSTRATION_DAILY_CAP_USD" : "MOTION_DAILY_CAP_USD", new Date(), kind === "still" ? "4" : "3"), now = new Date(), slot = kind === "still" ? "frames" : "legs";
    await jobs.insertOne({ _id: key, id: input.id as string, session_id: sid, walk_id: id, kind, index, status: "scheduled", request_sha256: requestHash, quote, input_sha256: quote.inputs_sha256, ledger_ids, created_at: now, updated_at: now }, options);
    await tx.collection<ImageLedWalkDoc>("image_led_walks").updateOne({ _id: current._id, revision: current.revision }, { $set: { [`${slot}.${index}.status`]: "scheduled", [`${slot}.${index}.job_id`]: input.id, status: "active", updated_at: now }, $inc: { revision: 1 } }, options);
    return { walk: imageLedWire({ ...current, [slot]: (kind === "still" ? current.frames : current.legs).map((s, i) => i === index ? { ...s, status: "scheduled", job_id: input.id } : s), status: "active", updated_at: now, revision: current.revision + 1 } as ImageLedWalkDoc) };
  });
}
/** Explicit owner fork reuses exact reviewed content, never a provider request. */
async function forkImageLedWalk(db: Db, walk: ImageLedWalkDoc, input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !["action", "id", "index", "revision"].includes(k)) || !imageLedUuid(input.id) || input.id === walk.id || !Number.isInteger(input.index) || Number(input.index) < 0 || Number(input.index) >= walk.frames.length || !Number.isSafeInteger(input.revision)) fail("Invalid repair fork", 400);
  const index = Number(input.index), key = `${walk.session_id}:${input.id}`, requestHash = imageLedHash({ action: "fork", id: input.id, index, revision: input.revision, parent_walk_id: walk.id }), collection = db.collection<ImageLedWalkDoc>("image_led_walks");
  const same = (old: ImageLedWalkDoc) => { if (old.request_sha256 !== requestHash) fail("Fork request id already belongs to another action"); return { walk: imageLedWire(old) }; };
  const existing = await collection.findOne({ _id: key, session_id: walk.session_id }); if (existing) return same(existing);
  if (walk.status === "archived" || walk.archive_provenance || walk.revision !== input.revision) fail("Reopen the current owned walk before forking");
  if ([...walk.frames, ...walk.legs].some(s => !["empty", "ready", "failed"].includes(s.status))) fail("Resolve the existing submission before forking");
  const prefix = walk.frames.slice(0, index);
  if (prefix.some(f => f.status !== "ready" || !f.image || f.review.sha256 !== f.image.sha256 || f.review.identity !== "approved" || f.review.route !== "approved" || !f.review.reviewed_at)) fail("Review each preserved artwork before forking");
  await requireImageLedCurrent(db, walk);
  for (const frame of prefix) for (const file of [frame.raw, frame.image]) if (file) {
    const read = await readImageLedImage(file.key, file);
    if (read.image.width !== file.width || read.image.height !== file.height || read.image.content_type !== file.content_type) fail("Preserved artwork dimensions or format changed");
  }
  const priorLegs = walk.legs.slice(0, Math.max(0, index - 1));
  for (const leg of priorLegs) if (leg.status === "ready") {
    if (!leg.video || !leg.original || leg.review.sha256 !== undefined && leg.review.sha256 !== leg.video.sha256 || !await verified(leg.video) || !await verified(leg.original)) fail("Preserved clip bytes changed", 503);
  }
  const seed = index > 0 ? walk.seed : undefined;
  if (seed && imageLedHash(await imageLedSeed(db, walk.session_id, seed, walk.source.image.sha256)) !== imageLedHash(seed)) fail("Starting artwork changed");
  return withDbTransaction(async (tx, session) => {
    const col = tx.collection<ImageLedWalkDoc>("image_led_walks"), options = { session }, old = await col.findOne({ _id: key }, options); if (old) return same(old);
    if (await col.countDocuments({ session_id: walk.session_id }, options) >= 30) fail("This world already has 30 image-led routes");
    await fenceImageLedSource(tx, session, walk); if (seed) await imageLedSeed(tx, walk.session_id, seed, walk.source.image.sha256, session);
    const now = new Date();
    if (!(await col.updateOne({ _id: walk._id, session_id: walk.session_id, revision: walk.revision }, { $inc: { revision: 1 }, $set: { updated_at: now } }, options)).matchedCount) fail("Walk review changed before forking");
    const next: ImageLedWalkDoc = { _id: key, id: input.id as string, session_id: walk.session_id, profile: walk.profile, created_at: now, updated_at: now, request_sha256: requestHash, status: "draft", revision: 1, source: structuredClone(walk.source), landmarks: structuredClone(walk.landmarks), route: structuredClone(walk.route), prompt: walk.prompt, ...(seed ? { seed: structuredClone(seed) } : {}),
      frames: walk.frames.map((f, i) => i < index ? { index: i, status: "ready", ...(f.raw ? { raw: structuredClone(f.raw) } : {}), image: structuredClone(f.image!), ...(f.derivative ? { derivative: structuredClone(f.derivative) } : {}), review: structuredClone(f.review) } : { index: i, status: "empty", review: { identity: "pending", route: "pending", spatial: "unmeasured" } }),
      legs: walk.legs.map((leg, i) => i < index - 1 && leg.status === "ready" ? { index: i, from: leg.from, to: leg.to, status: "ready", original: structuredClone(leg.original!), video: structuredClone(leg.video!), ...(leg.media ? { media: structuredClone(leg.media) } : {}), review: structuredClone(leg.review) } : { index: i, from: leg.from, to: leg.to, status: "empty", review: { temporal: "pending" } }) };
    await col.insertOne(next, options); return { walk: imageLedWire(next) };
  });
}
async function reviewImageLedWalk(db: Db, walk: ImageLedWalkDoc, input: Record<string, unknown>) {
  const kind = input.kind, index = input.index; if (Object.keys(input).some(k => !["action", "kind", "index", "sha256", "identity", "route", "temporal", "notes"].includes(k)) || !["still", "video"].includes(String(kind)) || !Number.isInteger(index) || typeof index !== "number" || index < 0 || typeof input.sha256 !== "string" || input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2000)) fail("Invalid artwork review", 400);
  if (walk.archive_provenance || walk.status === "archived") fail("Imported reviews are historical");
  const slot = kind === "still" ? walk.frames[index] : walk.legs[index], file = kind === "still" ? walk.frames[index]?.image : walk.legs[index]?.video;
  if (!slot || slot.status !== "ready" || !file || file.sha256 !== input.sha256) fail("Review the exact saved artwork or clip");
  if (kind === "still" ? !["approved", "rejected"].includes(String(input.identity)) || !["approved", "rejected"].includes(String(input.route)) || input.temporal !== undefined : !["approved", "rejected"].includes(String(input.temporal)) || input.identity !== undefined || input.route !== undefined) fail("Identity, route and temporal reviews are separate", 400);
  await requireImageLedCurrent(db, walk); if (kind === "still") await readImageLedImage(file.key, file); else if (!await verified(file)) fail("Saved clip bytes changed", 503);
  const next = kind === "still" ? { identity: input.identity, route: input.route, spatial: "unmeasured", sha256: file.sha256 } : { temporal: input.temporal, sha256: file.sha256 };
  const old = slot.review as unknown as Record<string, unknown>; if (old.reviewed_at) { const { reviewed_at: _at, notes: _notes, ...prior } = old; if (!isDeepStrictEqual(prior, next) || (old.notes ?? "") !== (input.notes ?? "")) fail("This saved review is immutable; preserve rejected drafts separately"); return { walk: imageLedWire(walk) }; }
  return withDbTransaction(async (tx, session) => { await fenceImageLedSource(tx, session, walk); const review = { ...next, reviewed_at: new Date().toISOString(), ...(input.notes ? { notes: input.notes } : {}) }, path = `${kind === "still" ? "frames" : "legs"}.${index}.review`;
    const complete = kind === "video" && input.temporal === "approved" && walk.legs.every((leg, i) => i === index || leg.status === "ready" && leg.review.temporal === "approved" && leg.review.sha256 === leg.video?.sha256);
    const result = await tx.collection<ImageLedWalkDoc>("image_led_walks").findOneAndUpdate({ _id: walk._id, revision: walk.revision }, { $set: { [path]: review, status: complete ? "complete" : "needs_review", updated_at: new Date() }, $inc: { revision: 1 } }, { session, returnDocument: "after" }); if (!result) fail("Review changed; reopen the saved work"); return { walk: imageLedWire(result) }; });
}
export { ownedWalk as readImageLedWalk };
