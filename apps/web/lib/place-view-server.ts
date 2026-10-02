import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { Matrix4 } from "three";
import type { ClientSession, Db } from "mongodb";
import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { placeScenesEnabled } from "./place-scene-enabled";
import type { SceneDoc } from "./place-scene-store";
import { getStoredBytes, uploadJpeg } from "./r2";
import { VIEW_PASSES, objectMaskColor, type PlaceViewExport, type SavedPlaceView, type ViewCapture, type ViewPass } from "./place-view";

import { currentSources, bindings, type PlaceViewDoc } from "./place-view-store";
import { wireIllustration } from "./illustration-server";
import type { MeshAssetDoc } from "./mesh-execution";
import { parseSavedCameraPath } from "./saved-camera-path";
export type { PlaceViewDoc } from "./place-view-store";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// 20 walk videos of 12 checkpoints each.
const WALK_CHECKPOINT_VIEWS = 240;
async function access(sid: string, pid?: string) {
  if (!isSafeId(sid) || pid !== undefined && !isSafeId(pid)) throw new CreatorError("Invalid place identity", 400);
  return requireCreator(sid);
}
export function parseCaptureMetadata(raw: unknown): ViewCapture {
  const c = raw as ViewCapture, finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!c || c.version !== 1 || !["plan", "orbit", "walk"].includes(c.mode) || !Number.isInteger(c.width) || !Number.isInteger(c.height)
    || c.width < 32 || c.height < 32 || c.width > 1024 || c.height > 1024 || !c.camera
    || !["perspective", "orthographic"].includes(c.camera.projection) || !finite(c.camera.near) || !finite(c.camera.far) || c.camera.near < 0 || c.camera.far <= c.camera.near || c.camera.far > 10000
    || ![c.camera.world_matrix, c.camera.projection_matrix].every(m => Array.isArray(m) && m.length === 16 && m.every(v => finite(v) && Math.abs(v) <= 100000))
    || !c.depth || c.depth.encoding !== "linear_view_z_8bit_near_white" || !finite(c.depth.near) || !finite(c.depth.far) || c.depth.near < c.camera.near || c.depth.far > c.camera.far || c.depth.far <= c.depth.near
    || c.normals !== "view_space_rgb" || c.surface_policy !== "opaque_geometry" || c.floor_id !== null && !isSafeId(c.floor_id)
    || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 16 || !Array.isArray(c.objects) || c.objects.length > 1000
    || !c.passes || VIEW_PASSES.some(pass => typeof c.passes[pass] !== "string")) throw new CreatorError("Invalid view capture", 400);
  for (const s of c.sources) if (!s || !isSafeId(s.scene_id) || !isSafeId(s.place_id) || !Number.isSafeInteger(s.revision) || s.revision < 1 || !finite(s.x) || !finite(s.z) || !s.definition) throw new CreatorError("Invalid view source", 400);
  const w = c.camera.world_matrix, p = c.camera.projection_matrix;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const basis = [0, 4, 8];
  const rigid = [3, 7, 11].every(i => close(w[i]!, 0)) && close(w[15]!, 1)
    && close(new Matrix4().fromArray(w).determinant(), 1)
    && basis.every(i => basis.every(j => close(w[i]! * w[j]! + w[i + 1]! * w[j + 1]! + w[i + 2]! * w[j + 2]!, i === j ? 1 : 0)));
  const perspective = c.camera.projection === "perspective", { near, far } = c.camera;
  const validProjection = p[0]! > 0 && p[5]! > 0 && [1, 2, 3, 4, 6, 7].every(i => close(p[i]!, 0))
    && Math.abs(new Matrix4().fromArray(p).determinant()) > Number.EPSILON
    && (perspective
      ? near > 0 && close(p[11]!, -1) && close(p[15]!, 0) && close(p[12]!, 0) && close(p[13]!, 0)
        && close(p[10]!, -(far + near) / (far - near)) && close(p[14]!, -2 * far * near / (far - near))
      : close(p[8]!, 0) && close(p[9]!, 0) && close(p[11]!, 0) && close(p[15]!, 1)
        && close(p[10]!, -2 / (far - near)) && close(p[14]!, -(far + near) / (far - near)));
  if (!rigid || !validProjection || (c.mode === "plan") === perspective || c.mode === "walk" && c.floor_id !== null) throw new CreatorError("Invalid view camera or projection", 400);
  if (new Set(c.sources.map(s => s.place_id)).size !== c.sources.length || c.objects.some(o => !o || !isSafeId(o.object_id) || !Array.isArray(o.rgb) || o.rgb.length !== 3 || o.rgb.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new CreatorError("Invalid view identities", 400);
  if (c.path && (c.mode !== "orbit" || c.sources.length !== 1)) throw new CreatorError("Camera paths require a single-place orbit view", 400);
  const path = c.path === undefined ? undefined : parseSavedCameraPath(c.path, c.camera, c.sources);
  // Only supported metadata crosses the persistence boundary. Pixel provenance
  // remains client-rendered, not a claim of server-attested reconstruction.
  return { version: 1, mode: c.mode, width: c.width, height: c.height, floor_id: c.floor_id, ...(path ? { path } : {}),
    camera: { projection: c.camera.projection, near, far, world_matrix: [...w], projection_matrix: [...p] },
    depth: { encoding: c.depth.encoding, near: c.depth.near, far: c.depth.far }, normals: c.normals, surface_policy: c.surface_policy,
    sources: c.sources.map(s => ({ scene_id: s.scene_id, place_id: s.place_id, revision: s.revision, x: s.x, z: s.z, definition: s.definition })),
    objects: c.objects.map(o => ({ object_id: o.object_id, rgb: [...o.rgb] })),
    passes: { render: c.passes.render, depth: c.passes.depth, normals: c.passes.normals, objects: c.passes.objects } };
}
export async function decodeViewPasses(c: ViewCapture) {
  const result = {} as Record<ViewPass, Buffer>; let total = 0;
  for (const pass of VIEW_PASSES) {
    const encoded = c.passes[pass].match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/)?.[1];
    if (!encoded || encoded.length > 6 * 1024 * 1024) throw new CreatorError("Invalid or oversized view PNG", 413);
    const bytes = Buffer.from(encoded, "base64"); total += bytes.length;
    if (bytes.toString("base64") !== encoded || total > 12 * 1024 * 1024) throw new CreatorError("Invalid or oversized view PNG", 413);
    try {
      const image = sharp(bytes, { limitInputPixels: 1024 * 1024 }); const info = await image.metadata();
      if (info.format !== "png" || info.width !== c.width || info.height !== c.height || (info.pages ?? 1) !== 1) throw new Error("Dimensions or format differ");
      await image.raw().toBuffer();
    } catch { throw new CreatorError("View passes must be valid PNGs with matching dimensions", 400); }
    result[pass] = bytes;
  }
  return result;
}
export const wirePlaceView = (doc: PlaceViewDoc, historical: boolean): SavedPlaceView => {
  const { _id: _key, session_id: _sid, request_sha256: _request, files: _files, ...view } = doc;
  return { ...view, historical };
};
export async function savePlaceView(sid: string, pid: string, input: Record<string, unknown>) {
  const db = await access(sid, pid);
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(input.id) || typeof input.label !== "string" || input.label.trim().length < 1 || input.label.length > 120) throw new CreatorError("Give this view a name and valid identity", 400);
  const capture = parseCaptureMetadata(input.capture), request_sha256 = hash(input), key = `${sid}:${input.id}`;
  // Walk-video checkpoints are saved views with their own cap, outside the
  // user's 50 views, the library list and the export (walk videos are not exported).
  const checkpoint = input.walk_checkpoint === true;
  if (input.walk_checkpoint !== undefined && (!checkpoint || capture.mode !== "walk")) throw new CreatorError("Walk checkpoints must be walk views", 400);
  const [kind, limit, limitMessage] = checkpoint ? [{ walk_checkpoint: true as const }, WALK_CHECKPOINT_VIEWS, `This place already has ${WALK_CHECKPOINT_VIEWS} walk checkpoint views`]
    : [{ walk_checkpoint: { $exists: false } }, 50, "This place already has 50 saved views"];
  const prior = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: key });
  if (prior) { if (prior.request_sha256 !== request_sha256 || prior.root_place_id !== pid) throw new CreatorError("View identity already used", 409); return { id: prior.id }; }
  const refreshedFrom = input.refreshed_from;
  const validateRefresh = async (database: typeof db, session?: ClientSession) => {
    if (refreshedFrom === undefined) return;
    if (!isSafeId(refreshedFrom) || refreshedFrom === input.id) throw new CreatorError("Invalid source camera view", 400);
    const source = await database.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${refreshedFrom}`, session_id: sid }, session ? { session } : {});
    if (!source || source.root_place_id !== pid) throw new CreatorError("Source camera view is unavailable", 409);
    // Checkpoints are not exported, so a refresh history through one could not be imported.
    if (checkpoint || source.walk_checkpoint) throw new CreatorError("Walk checkpoint views cannot be refreshed", 409);
    if (source.mode !== capture.mode || source.floor_id !== capture.floor_id || source.width !== capture.width || source.height !== capture.height
      || !isDeepStrictEqual(source.camera, capture.camera) || capture.path
      || !capture.sources.some(s => s.place_id === pid && source.sources.some(old => old.place_id === pid && old.scene_id === s.scene_id))) throw new CreatorError("Refreshed view must retain the exact saved camera and framing", 409);
  };
  await validateRefresh(db);
  const sources = await currentSources(db, sid, pid, capture.mode);
  if (capture.path && sources.some(source => source.definition.material_pack)) throw new CreatorError("Legacy atlas camera paths require immutable atlas provenance before saving", 409);
  if (!isDeepStrictEqual([...capture.sources].sort((a, b) => a.place_id.localeCompare(b.place_id)), sources)) throw new CreatorError("View geometry changed. Capture the saved scene again.", 409);
  if (capture.floor_id && (capture.mode === "walk" || !sources.some(s => s.definition.objects.some(o => o.structure?.floors.some(f => f.id === capture.floor_id))))) throw new CreatorError("View floor is unavailable", 400);
  const ids = sources.flatMap(s => s.definition.objects.map(o => o.id)).sort();
  if (new Set(ids).size !== ids.length || !isDeepStrictEqual(capture.objects, ids.map((object_id, i) => ({ object_id, rgb: objectMaskColor(i) })))) throw new CreatorError("View object mask identities differ", 400);
  const binding = await bindings(db, sid, sources);
  // Each "Make walk video" saves its checkpoints again: a current checkpoint at
  // the same camera and size is reused, so previews do not fill the cap.
  if (checkpoint) {
    const same = (await db.collection<PlaceViewDoc>("place_views").find({ session_id: sid, root_place_id: pid, walk_checkpoint: true, width: capture.width, height: capture.height }).toArray())
      .find(v => isDeepStrictEqual(v.camera, capture.camera) && isDeepStrictEqual({ sources: v.sources, assets: v.assets }, binding));
    if (same) return { id: same.id };
  }
  if (await db.collection<PlaceViewDoc>("place_views").countDocuments({ session_id: sid, root_place_id: pid, ...kind }) >= limit) throw new CreatorError(limitMessage, 409);
  const decoded = await decodeViewPasses(capture);
  const files = {} as PlaceViewDoc["files"];
  for (const pass of VIEW_PASSES) {
    const bytes = decoded[pass], sha256 = bytesHash(bytes), path = `${sid}/views/${input.id}/${pass}-${sha256}.png`;
    await uploadJpeg(path, bytes, "image/png", AbortSignal.timeout(90_000)); files[pass] = { key: path, sha256, bytes: bytes.length };
  }
  const { sources: _sources, passes: _passes, ...metadata } = capture;
  const doc: PlaceViewDoc = { ...metadata, ...binding, _id: key, id: input.id as string, session_id: sid, root_place_id: pid,
    label: input.label.trim(), request_sha256, created_at: new Date().toISOString(), files, provenance: "client_rendered_saved_geometry", ...(checkpoint ? { walk_checkpoint: true as const } : {}), ...(typeof refreshedFrom === "string" ? { refreshed_from: refreshedFrom } : {}) };
  return withDbTransaction(async (db, session) => {
    const col = db.collection<PlaceViewDoc>("place_views"), options = { session };
    const existing = await col.findOne({ _id: key }, options);
    if (existing) { if (existing.request_sha256 !== request_sha256) throw new CreatorError("View identity already used", 409); return { id: existing.id }; }
    await validateRefresh(db, session);
    if (!isDeepStrictEqual(await bindings(db, sid, await currentSources(db, sid, pid, capture.mode, session), session), binding)) throw new CreatorError("View sources changed during storage. Capture again.", 409);
    if (await col.countDocuments({ session_id: sid, root_place_id: pid, ...kind }, options) >= limit) throw new CreatorError(limitMessage, 409);
    // Serialize publication with structural/frame edits, without changing geometry
    // or its revision. Reads alone would permit snapshot-isolation write skew.
    for (const source of sources) await db.collection<SceneDoc>("place_scenes").updateOne({ _id: `${sid}:${source.place_id}`, revision: source.revision }, { $inc: { view_capture_fence: 1 } }, options);
    if (sources.length > 1) await db.collection<{ _id: string; view_capture_fence?: number }>("world_map").updateOne({ _id: sid }, { $inc: { view_capture_fence: 1 } }, options);
    await col.insertOne(doc, options); return { id: doc.id };
  });
}
export async function placeViewLibrary(sid: string, pid: string) {
  const db = await access(sid, pid), docs = await db.collection<PlaceViewDoc>("place_views").find({ session_id: sid, root_place_id: pid, walk_checkpoint: { $exists: false } }).sort({ created_at: -1 }).limit(50).toArray();
  const cache = new Map<string, Awaited<ReturnType<typeof bindings>> | null>(), views: SavedPlaceView[] = [];
  for (const doc of docs) {
    if (!cache.has(doc.mode)) {
      try { cache.set(doc.mode, await bindings(db, sid, await currentSources(db, sid, pid, doc.mode))); }
      catch (e) { if (!(e instanceof CreatorError)) throw e; cache.set(doc.mode, null); }
    }
    views.push(wirePlaceView(doc, !isDeepStrictEqual(cache.get(doc.mode), { sources: doc.sources, assets: doc.assets })));
  }
  return { views };
}
export async function placeViewBytes(sid: string, id: string, pass: ViewPass) {
  const db = await access(sid);
  if (!isSafeId(id) || !VIEW_PASSES.includes(pass)) throw new CreatorError("Invalid saved view", 400);
  const doc = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${id}`, session_id: sid });
  if (!doc) throw new CreatorError("Saved view not found", 404);
  return readPass(doc, pass);
}
async function readPass(doc: PlaceViewDoc, pass: ViewPass) {
  const file = doc.files[pass], stored = await getStoredBytes(file.key);
  if (!stored || stored.bytes.length !== file.bytes || bytesHash(stored.bytes) !== file.sha256) throw new CreatorError("Saved view is unavailable or corrupted", 503);
  return stored.bytes;
}
export interface PlaceViewExportSnapshot {
  doc: PlaceViewDoc;
  view: SavedPlaceView;
  illustrations: MeshAssetDoc[];
}

// Capture metadata in the caller's snapshot. Immutable object downloads happen
// after the transaction, so slow storage cannot hold a database snapshot open.
export async function snapshotPlaceViewExports(db: Db, sid: string, session: ClientSession): Promise<PlaceViewExportSnapshot[]> {
  const options = { session };
  const docs = await db.collection<PlaceViewDoc>("place_views").find({ session_id: sid, walk_checkpoint: { $exists: false } }, options).sort({ created_at: 1 }).limit(501).toArray();
  if (docs.length > 500 || docs.reduce((sum, d) => sum + VIEW_PASSES.reduce((n, pass) => n + d.files[pass].bytes, 0), 0) > 64 * 1024 * 1024) throw new CreatorError("Camera view export exceeds 500 views or 64 MiB", 413);
  const cache = new Map<string, Awaited<ReturnType<typeof bindings>> | null>(), result: PlaceViewExportSnapshot[] = [];
  for (const doc of docs) {
    const key = JSON.stringify([doc.root_place_id, doc.mode]);
    if (!cache.has(key)) {
      try { cache.set(key, await bindings(db, sid, await currentSources(db, sid, doc.root_place_id, doc.mode, session), session)); }
      catch (e) { if (!(e instanceof CreatorError)) throw e; cache.set(key, null); }
    }
    const view = wirePlaceView(doc, !isDeepStrictEqual(cache.get(key), { sources: doc.sources, assets: doc.assets }));
    const illustrations = await db.collection<MeshAssetDoc>("illustration_assets").find({ session_id: sid, "view_dependency.view_id": doc.id }, options).sort({ created_at: 1 }).limit(51).toArray();
    if (illustrations.length > 50) throw new CreatorError("Illustration export exceeds 50 assets per view", 413);
    result.push({ doc, view, illustrations });
  }
  return result;
}

export async function downloadPlaceViewExports(snapshot: PlaceViewExportSnapshot[]): Promise<PlaceViewExport[]> {
  const result: PlaceViewExport[] = [];
  let totalBytes = 0;
  for (const { doc, view, illustrations: assets } of snapshot) {
    const passes: PlaceViewExport["passes"] = [];
    for (const pass of VIEW_PASSES) { const bytes = await readPass(doc, pass); totalBytes += bytes.length; passes.push({ pass, sha256: doc.files[pass].sha256, bytes }); }
    const illustrations: NonNullable<PlaceViewExport["illustrations"]> = [];
    for (const asset of assets) {
      totalBytes += asset.bytes;
      if (totalBytes > 64 * 1024 * 1024) throw new CreatorError("Camera view export exceeds 64 MiB", 413);
      const stored = await getStoredBytes(asset.key);
      if (!stored || stored.bytes.length !== asset.bytes || bytesHash(stored.bytes) !== asset.sha256) throw new CreatorError("Saved illustration is unavailable or corrupted", 503);
      illustrations.push({ asset: wireIllustration(asset, doc, view.historical), bytes: stored.bytes });
    }
    if (totalBytes > 64 * 1024 * 1024) throw new CreatorError("Camera view export exceeds 64 MiB", 413);
    const { _id: _key, session_id: _sid, files: _files, accepted_illustration_id: _accepted, ...capture_metadata } = doc;
    result.push({ view, capture_metadata, passes, ...(illustrations.length ? { illustrations } : {}) });
  }
  return result;
}

export async function exportPlaceViews(sid: string): Promise<PlaceViewExport[]> {
  await access(sid);
  const snapshot = await withDbTransaction((db, session) => snapshotPlaceViewExports(db, sid, session), { readConcern: { level: "snapshot" } });
  return downloadPlaceViewExports(snapshot);
}
