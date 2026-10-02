import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator-error";
import { getStoredBytes } from "./r2";
import { assertCurrentView, viewHash, type PlaceViewDoc } from "./place-view-store";
import { VIEW_PASSES } from "./place-view";
import type { IllustrationEditInput, IllustrationKeyframeInput } from "./place-view";
import type { MeshAssetDoc, ViewDependency } from "./mesh-docs";
export type { ViewDependency } from "./mesh-docs";
import { registeredObjectMask, registeredPixels } from "./illustration-region";
import sharp from "sharp";
import { illustrationIdentity } from "./illustration-identity";
import { prepareKeyframeInput, type KeyframeChain, type KeyframePasses } from "./illustration-keyframe-server";
import type { SceneDoc } from "./place-scene-store";

// Exclude ownership, storage locations and mutable review state so immutable
// provenance remains valid after an owner fork.
export function illustrationDependency(view: PlaceViewDoc): ViewDependency {
  const { _id: _key, session_id: _sid, files, accepted_illustration_id: _accepted, ...capture } = view;
  return { view_id: view.id, width: view.width, height: view.height, input_sha256: viewHash({ capture,
    passes: VIEW_PASSES.map(pass => ({ pass, sha256: files[pass].sha256, bytes: files[pass].bytes })) }) };
}
async function savedView(db: Db, sid: string, dependency: ViewDependency, session?: ClientSession) {
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${dependency.view_id}`, session_id: sid }, session ? { session } : {});
  if (!view || viewHash(illustrationDependency(view)) !== viewHash(dependency)) throw new CreatorError("Saved illustration input is missing or changed", 409);
  return view;
}
export async function illustrationSource(db: Db, sid: string, dependency: ViewDependency, session?: ClientSession) {
  const view = await savedView(db, sid, dependency, session);
  const sources = await assertCurrentView(db, view, session);
  if (sources.some(s => s.definition.material_pack)) throw new CreatorError("Legacy material packs need immutable atlas bindings before illustration generation", 409);
  return view;
}
export async function illustrationEditSource(db: Db, sid: string, view: PlaceViewDoc, edit: IllustrationEditInput, session?: ClientSession) {
  if ((view.accepted_illustration_id ?? null) !== edit.base_id || view.files.objects.sha256 !== edit.mask_sha256) throw new CreatorError("Accepted artwork or edit mask changed", 409);
  const asset = edit.base_id ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${edit.base_id}`, session_id: sid }, session ? { session } : {}) : null;
  if (edit.base_id && (!asset?.view_dependency || viewHash(asset.view_dependency) !== viewHash(illustrationDependency(view)))) throw new CreatorError("Edit base does not belong to this saved camera", 409);
  const file = asset ?? view.files.render;
  if (file.sha256 !== edit.base_sha256) throw new CreatorError("Accepted edit base changed", 409);
  return file;
}
export async function prepareIllustrationInput(db: Db, sid: string, dependency: ViewDependency, edit?: IllustrationEditInput, identity = false) {
  const view = await illustrationSource(db, sid, dependency);
  const images: string[] = [];
  for (const pass of ["render", "depth"] as const) {
    const file = edit && pass === "render" ? await illustrationEditSource(db, sid, view, edit) : view.files[pass];
    const stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
    if (!stored || stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new Error("Saved illustration input bytes are unavailable");
    const bytes = edit && pass === "render" ? await sharp(await registeredPixels(stored.bytes, view.width, view.height), { raw: { width: view.width, height: view.height, channels: 4 } }).png().toBuffer() : stored.bytes;
    images.push(`data:image/png;base64,${bytes.toString("base64")}`);
  }
  let mask: string | undefined;
  if (edit) {
    const file = view.files.objects, stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
    if (!stored || stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== edit.mask_sha256) throw new Error("Saved illustration mask bytes are unavailable");
    mask = `data:image/png;base64,${(await registeredObjectMask(stored.bytes, view, edit.object_ids, edit.brush_strokes)).bytes.toString("base64")}`;
  }
  let scene_identity: ReturnType<typeof illustrationIdentity> | undefined;
  if (identity) {
    const file = view.files.objects, stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
    if (!stored || stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new Error("Saved identity mask bytes are unavailable");
    const sources = await assertCurrentView(db, view);
    scene_identity = illustrationIdentity(view, sources, await registeredPixels(stored.bytes, view.width, view.height, true));
  }
  return { image_url: images[0]!, control_lora_image_url: images[1]!, image_size: { width: view.width, height: view.height }, ...(mask ? { mask_url: mask } : {}), ...(scene_identity ? { scene_identity } : {}) };
}

async function verifiedBytes(file: { key: string; sha256: string; bytes?: number }) {
  const stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!stored || file.bytes !== undefined && stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new Error("Saved keyframe input bytes are unavailable");
  return stored.bytes;
}
// A saved view as one keyframe capture. Geometry need not be current here, so
// a late result for an older capture is still stored as a historical draft.
export async function keyframeViewPasses(view: PlaceViewDoc): Promise<KeyframePasses> {
  const [render, depth, objects] = await Promise.all((["render", "depth", "objects"] as const).map(pass => verifiedBytes(view.files[pass])));
  return { view, render: render!, depth: depth!, objects: objects! };
}
/** The place's source picture (the world's art), pinned by key and hash; null for a source-free world. */
export async function keyframeArt(db: Db, sid: string, placeId: string) {
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${placeId}`, session_id: sid });
  if (!scene?.source_image_key) return null;
  const stored = await getStoredBytes(scene.source_image_key, AbortSignal.timeout(30_000));
  if (!stored) throw new CreatorError("The world's art is unavailable. Try again, or paint from words.", 503);
  return { key: scene.source_image_key, sha256: createHash("sha256").update(stored.bytes).digest("hex") };
}
/** The accepted keyframe at camera A. `current` also requires A's geometry to be current. */
export async function keyframeChainSource(db: Db, sid: string, from: NonNullable<IllustrationKeyframeInput["chain_from"]>, current: boolean, session?: ClientSession) {
  const asset = await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${from.illustration_id}`, session_id: sid }, session ? { session } : {});
  if (!asset?.view_dependency || asset.view_dependency.view_id !== from.view_id || asset.sha256 !== from.sha256 || asset.edit_input) throw new CreatorError("The previous keyframe changed", 409);
  return { asset, view: current ? await illustrationSource(db, sid, asset.view_dependency, session) : await savedView(db, sid, asset.view_dependency, session) };
}
/**
 * The shift from camera A's world frame to camera B's. Plan and orbit views
 * draw the root place at the origin; walk views of a connected place draw it
 * at its chunk offset. Null when either view lacks that offset.
 */
export function chainShift(a: Pick<PlaceViewDoc, "root_place_id" | "sources">, b: Pick<PlaceViewDoc, "root_place_id" | "sources">) {
  const ra = a.sources.find(s => s.place_id === a.root_place_id), rb = b.sources.find(s => s.place_id === b.root_place_id);
  const x = ra && rb ? rb.x - ra.x : NaN, z = ra && rb ? rb.z - ra.z : NaN;
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}
// Camera A moves into B's frame, so A's points, eye and parallax angle are all measured there.
async function keyframeChain(db: Db, sid: string, from: NonNullable<IllustrationKeyframeInput["chain_from"]>, current: boolean, to: PlaceViewDoc): Promise<KeyframeChain> {
  const { asset, view } = await keyframeChainSource(db, sid, from, current), shift = chainShift(view, to);
  if (!shift) throw new CreatorError("The camera to continue from cannot be lined up with this one", 409);
  const world_matrix = view.camera.world_matrix.map((v, i) => v + (i === 12 ? shift.x : i === 14 ? shift.z : 0));
  return { view: { ...view, camera: { ...view.camera, world_matrix } }, depth: await verifiedBytes(view.files.depth), image: await verifiedBytes(asset) };
}
/** A keyframe job's captures for finishing; no current-geometry check. */
export async function keyframeJobPasses(db: Db, sid: string, dependency: ViewDependency, input: IllustrationKeyframeInput) {
  const view = await savedView(db, sid, dependency);
  return { passes: await keyframeViewPasses(view), chain: input.chain_from ? await keyframeChain(db, sid, input.chain_from, false, view) : undefined };
}
/** Provider inputs for a saved view's keyframe, from current geometry and pinned bytes. */
export async function prepareKeyframeViewInput(db: Db, sid: string, dependency: ViewDependency, input: IllustrationKeyframeInput) {
  const view = await illustrationSource(db, sid, dependency), sources = await assertCurrentView(db, view);
  const art = input.reference ? await verifiedBytes(input.reference) : null;
  const chain = input.chain_from ? await keyframeChain(db, sid, input.chain_from, true, view) : undefined;
  return prepareKeyframeInput(await keyframeViewPasses(view), sources, art, chain);
}
