import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator-error";
import { getStoredBytes } from "./r2";
import { assertCurrentView, viewHash, type PlaceViewDoc } from "./place-view-store";
import { VIEW_PASSES } from "./place-view";
import type { IllustrationEditInput } from "./place-view";
import type { MeshAssetDoc } from "./mesh-execution";
import { registeredObjectMask, registeredPixels } from "./illustration-region";
import sharp from "sharp";
import { illustrationIdentity } from "./illustration-identity";

export interface ViewDependency { view_id: string; input_sha256: string; width: number; height: number }
// Exclude ownership, storage locations and mutable review state so immutable
// provenance remains valid after an owner fork.
export function illustrationDependency(view: PlaceViewDoc): ViewDependency {
  const { _id: _key, session_id: _sid, files, accepted_illustration_id: _accepted, ...capture } = view;
  return { view_id: view.id, width: view.width, height: view.height, input_sha256: viewHash({ capture,
    passes: VIEW_PASSES.map(pass => ({ pass, sha256: files[pass].sha256, bytes: files[pass].bytes })) }) };
}
export async function illustrationSource(db: Db, sid: string, dependency: ViewDependency, session?: ClientSession) {
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${dependency.view_id}`, session_id: sid }, session ? { session } : {});
  if (!view || viewHash(illustrationDependency(view)) !== viewHash(dependency)) throw new CreatorError("Saved illustration input is missing or changed", 409);
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
