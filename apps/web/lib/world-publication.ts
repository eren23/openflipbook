import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import type { Entity, PlaceConnection, PlaceSceneDefinition, WorldEntityGeo } from "@openflipbook/config";
import { CreatorError, requireCreator } from "./creator";
import { getDb, withDbTransaction } from "./db";
import { isSafeId } from "./ids";
import { materialAssetIds } from "./surface-material";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import type { SceneDoc } from "./place-scene-store";
import type { MeshAssetDoc } from "./mesh-docs";
import type { MotionStudyDoc } from "./motion-study";
import type { PathVideoDoc } from "./path-video";
import { getStoredBytes, uploadJpeg } from "./r2";
import { getExistingOwnerToken } from "./session-owner";
import JSZip from "jszip";
import { sceneGeos } from "./place-scene";
import { localBounds, resolveAbsoluteFrame, toAbsoluteEntities } from "./world-geometry";
import { publicationConnection, publicationGeometry, type PublicationPlacement } from "./world-publication-geometry";
import type { ConnectionDoc } from "./place-connection-graph";
import { validateConnections } from "./place-connections";

interface PublicationFile { id: string; key: string; sha256: string; bytes: number; content_type: string }
export interface PublicationCapture {
  provenance: "client_rendered_saved_geometry";
  historical: boolean;
  sources: { place_id: string; revision: number; definition_sha256?: string }[];
}
export interface WorldPublication {
  version: 1; id: string; title: string; created_at: string;
  scenes: { place_id: string; revision: number; definition: PlaceSceneDefinition }[];
  views: { id: string; label: string; mode: string; floor_id: string | null; file_id: string; capture?: PublicationCapture }[];
  videos: { id: string; label: string; file_id: string; duration: number; capture?: PublicationCapture }[];
  assets: { id: string; kind: "mesh" | "material"; file_id: string }[];
  // Optional only for snapshots created before connected publication support.
  placements?: PublicationPlacement[];
  connections?: PlaceConnection[];
}
interface PublicationDoc extends WorldPublication {
  _id: string; session_id: string; request_sha256: string; source_sha256: string;
  files: PublicationFile[]; active: boolean;
  asset_receipts: { id: string; kind: "mesh" | "material"; geometry?: MeshAssetDoc["geometry"]; image?: MeshAssetDoc["image"] }[];
}
const publicWire = (doc: PublicationDoc): WorldPublication => ({ version: 1, id: doc.id, title: doc.title, created_at: doc.created_at,
  scenes: doc.scenes, views: doc.views, videos: doc.videos, assets: doc.assets,
  ...(doc.placements ? { placements: doc.placements } : {}), ...(doc.connections ? { connections: doc.connections } : {}) });
async function sources(db: Db, sid: string, session?: ClientSession) {
  const options = session ? { session } : {};
  const read = async <T extends { session_id: string }>(name: string, cap: number) => {
    const rows = await db.collection<T>(name).find({ session_id: sid } as never, options).limit(cap + 1).toArray();
    if (rows.length > cap) throw new CreatorError("Publication source exceeds the supported world size", 413);
    return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  const [scenes, views, paths, meshes, materials, illustrations, studies, connections, map] = await Promise.all([
    read<SceneDoc>("place_scenes", 200), read<PlaceViewDoc>("place_views", 1000), read<PathVideoDoc>("path_videos", 200),
    read<MeshAssetDoc>("mesh_assets", 1000), read<MeshAssetDoc>("material_assets", 1000), read<MeshAssetDoc>("illustration_assets", 2000), read<MotionStudyDoc>("motion_studies", 500),
    read<ConnectionDoc>("place_connections", 256), db.collection<{ _id: string; entities: WorldEntityGeo[] }>("world_map").findOne({ _id: sid }, options),
  ]);
  if (map && (!Array.isArray(map.entities) || map.entities.length > 10000)) throw new CreatorError("Publication map exceeds the supported world size", 413);
  return { scenes, views, paths, meshes, materials, illustrations, studies, connections, map };
}
const sourceHash = (s: Awaited<ReturnType<typeof sources>>) => viewHash({ scenes: s.scenes.map(x => [x.id, x.place_id, x.revision, x.definition]),
  views: s.views.map(x => [x.id, x.label, x.mode, x.floor_id, x.purpose, x.root_place_id, x.sources, x.files, x.accepted_illustration_id]),
  paths: s.paths.map(x => [x.id, x.status, x.video, x.media, x.view_ids, x.study_id, x.views_sha256, x.study_sha256]),
  studies: s.studies.map(x => [x.id, x.source]), connections: s.connections.map(publicationConnection),
  placements: s.map?.entities.filter(x => s.scenes.some(scene => scene.place_id === x.id)).map(x =>
    [x.id, x.scene_id, x.entity_id, x.parent_id, x.pos, x.footprint, x.scale, x.heading, x.elevation]),
  // Ancestor transforms matter when a saved place uses a nested map frame.
  frames: s.map?.entities.filter(x => x.kind === "place").map(x => [x.id, x.parent_id, x.pos, x.footprint, x.scale]),
  assets: [...s.meshes, ...s.materials, ...s.illustrations].map(x => [x.id, x.key, x.sha256, x.bytes, x.geometry, x.image, x.content_type]) });

function selectedPlacements(s: Awaited<ReturnType<typeof sources>>, selected: SceneDoc[]): PublicationPlacement[] {
  const all = s.map?.entities ?? [], absolute = toAbsoluteEntities(all, all), byId = new Map(all.map(g => [g.id, g]));
  if (byId.size !== all.length) throw new CreatorError("The saved map has duplicate geometry identities", 409);
  return selected.map(scene => {
    const saved = absolute.find(g => g.id === scene.place_id);
    if (s.map && (!saved || saved.kind !== "place" || saved.scene_id !== scene.id)) throw new CreatorError("Selected place placement does not match its saved scene", 409);
    const seen = new Set<string>(); let ancestor = byId.get(scene.place_id);
    while (ancestor) {
      if (seen.has(ancestor.id) || ![ancestor.pos.x, ancestor.pos.y, ancestor.scale ?? 1].every(Number.isFinite) || (ancestor.scale ?? 1) <= 0)
        throw new CreatorError("Selected place has an invalid map frame", 409);
      seen.add(ancestor.id);
      const parent = ancestor.parent_id;
      if (parent && !byId.has(parent)) throw new CreatorError("Selected place map frame is missing", 409);
      ancestor = parent ? byId.get(parent) : undefined;
    }
    const frame = saved ?? sceneGeos(scene, [])[0]!;
    return { place_id: scene.place_id, entity_id: frame.entity_id ?? `entity_${viewHash(scene.place_id)}`,
      pos: { x: frame.pos.x, y: frame.pos.y }, footprint: { w: frame.footprint.w, d: frame.footprint.d },
      scale: (frame.scale ?? 1) * (resolveAbsoluteFrame(scene.place_id, byId)?.unit ?? 1),
      heading: frame.heading ?? 0, elevation: frame.elevation ?? 0 };
  });
}
export async function publicationChoices(sid: string) {
  const db = await requireCreator(sid), s = await sources(db, sid);
  const publications = await db.collection<PublicationDoc>("world_publications").find({ session_id: sid, active: true }).limit(40).toArray();
  return { source_sha256: sourceHash(s), places: s.scenes.map(x => ({ id: x.place_id, label: x.definition.label })),
    views: s.views.filter(x => !x.walk_checkpoint).map(x => ({ id: x.id, label: x.label, place_ids: x.sources.map(v => v.place_id) })),
    videos: s.paths.filter(x => x.status === "ready" && x.video).map(x => ({ id: x.id, label: x.view_ids ? "Walk video" : "Camera path" })),
    publications: publications.map(x => ({ id: x.id, title: x.title })), imported_snapshot: !!await db.collection<{ _id: string; [key: string]: unknown }>("publication_libraries").findOne({ _id: sid }) };
}
function ids(value: unknown, cap: number): string[] {
  if (!Array.isArray(value) || value.length > cap || !value.every(isSafeId) || new Set(value).size !== value.length) throw new CreatorError("Invalid publication selection", 400);
  return value;
}
function captureMetadata(records: { place_id: string; revision: number; definition_sha256?: string; definition?: PlaceSceneDefinition }[],
  scenes: WorldPublication["scenes"]): PublicationCapture {
  if (!records.length || records.length > 256) throw new CreatorError("Selected capture revision metadata is unavailable", 409);
  const unique = new Map<string, PublicationCapture["sources"][number]>();
  for (const record of records) {
    const sha256 = record.definition ? viewHash(record.definition) : record.definition_sha256;
    if (!isSafeId(record.place_id) || !Number.isSafeInteger(record.revision) || record.revision < 1 || !scenes.some(s => s.place_id === record.place_id)
      || sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new CreatorError("Selected capture revision metadata is unavailable", 409);
    const source = { place_id: record.place_id, revision: record.revision, ...(sha256 ? { definition_sha256: sha256 } : {}) };
    unique.set(viewHash(source), source);
  }
  const sources = [...unique.values()];
  return { provenance: "client_rendered_saved_geometry", sources, historical: sources.some(source => {
    const current = scenes.find(scene => scene.place_id === source.place_id)!;
    return current.revision !== source.revision || !!source.definition_sha256 && viewHash(current.definition) !== source.definition_sha256;
  }) };
}
/** Whitelist selected content. Private notes, prompts, credentials, jobs, and source image references never enter the public document. */
export function selectPublication(s: Awaited<ReturnType<typeof sources>>, input: Record<string, unknown>) {
  const placeIds = ids(input.place_ids, 16), viewIds = ids(input.view_ids, 50), pathIds = ids(input.path_ids, 20);
  if (!placeIds.length) throw new CreatorError("Select at least one saved place", 400);
  const selectedScenes = placeIds.map(id => { const x = s.scenes.find(x => x.place_id === id); if (!x) throw new CreatorError("Selected place is unavailable", 409); return x; });
  const scenes = selectedScenes.map(x => {
    return { place_id: x.place_id, revision: x.revision, definition: structuredClone(x.definition) }; });
  const placements = selectedPlacements(s, selectedScenes);
  const connections = s.connections.filter(c => placeIds.includes(c.a.place_id) && placeIds.includes(c.b.place_id)).map(publicationConnection);
  try {
    validateConnections(connections, selectedScenes, s.map?.entities ?? selectedScenes.flatMap(scene => sceneGeos(scene, [])));
    publicationGeometry({ scenes, placements, connections });
  }
  catch (e) { throw new CreatorError((e as Error).message, 409); }
  const files: PublicationFile[] = [], add = (id: string, file: { key: string; sha256: string; bytes: number }, content_type: string) => {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 128 * 1024 * 1024) throw new CreatorError("Selected media lacks an immutable receipt", 409);
    files.push({ id, key: file.key, sha256: file.sha256, bytes: file.bytes, content_type }); return id;
  };
  const assets: WorldPublication["assets"] = [], asset_receipts: PublicationDoc["asset_receipts"] = [];
  for (const kind of ["mesh", "material"] as const) {
    const required = [...new Set(scenes.flatMap(x => kind === "mesh" ? x.definition.objects.flatMap(o => o.asset_id ? [o.asset_id] : []) : materialAssetIds(x.definition)))];
    for (const id of required) { const asset = (kind === "mesh" ? s.meshes : s.materials).find(x => x.id === id);
      if (!asset) throw new CreatorError("A selected place asset is missing", 409);
      asset_receipts.push({ id, kind, ...(asset.geometry ? { geometry: asset.geometry } : {}), ...(asset.image ? { image: asset.image } : {}) });
      assets.push({ id, kind, file_id: add(`${kind}_${id}`, asset, kind === "mesh" ? "model/gltf-binary" : "image/jpeg") }); }
  }
  const views = viewIds.map(id => { const v = s.views.find(x => x.id === id);
    if (!v || v.walk_checkpoint || v.sources.some(x => !placeIds.includes(x.place_id))) throw new CreatorError("Select every place visible in a published view", 409);
    const image = v.accepted_illustration_id ? s.illustrations.find(x => x.id === v.accepted_illustration_id) : null;
    if (v.accepted_illustration_id && !image) throw new CreatorError("Selected artwork is unavailable", 409);
    return { id, label: v.label, mode: v.mode, floor_id: v.floor_id, capture: captureMetadata(v.sources, scenes),
      file_id: add(`view_${id}`, image ?? v.files.render, image ? image.content_type ?? "image/jpeg" : "image/png") }; });
  const videos = pathIds.map(id => { const v = s.paths.find(x => x.id === id);
    if (!v || v.status !== "ready" || !v.video || !v.media || v.media.audio_streams !== 0) throw new CreatorError("Select a completed silent video", 409);
    if (v.view_ids?.some(id => !s.views.some(x => x.id === id))) throw new CreatorError("Published video source is missing", 409);
    const study = v.view_ids ? null : s.studies.find(x => x.id === v.study_id);
    if (!v.view_ids && (!study || !study.source.definitions.length || !study.source.view.sources.length)) throw new CreatorError("Published video source is missing", 409);
    if (study && v.study_sha256 && viewHash(study) !== v.study_sha256) throw new CreatorError("Published video capture receipt changed", 409);
    const used = v.view_ids ? s.views.filter(x => v.view_ids!.includes(x.id)).flatMap(x => x.sources.map(y => y.place_id))
      : [study!.source.view.root_place_id, ...study!.source.view.sources.map(x => x.place_id), ...study!.source.definitions.map(x => x.place_id)];
    if (!used.length || used.some(x => !x || !placeIds.includes(x))) throw new CreatorError("Select every place shown in a published video", 409);
    const capture = captureMetadata(v.view_ids ? s.views.filter(x => v.view_ids!.includes(x.id)).flatMap(x => x.sources)
      : [...study!.source.view.sources, ...study!.source.definitions], scenes);
    return { id, label: v.view_ids ? "Walk video" : "Camera path", capture,
      file_id: add(`video_${id}`, v.video, "video/mp4"), duration: v.media.duration }; });
  if (files.reduce((sum, x) => sum + x.bytes, 0) > 256 * 1024 * 1024) throw new CreatorError("Publication exceeds 256 MiB", 413);
  return { scenes, placements, connections, views, videos, assets, files, asset_receipts };
}
async function verifiedFile(file: PublicationFile) {
  const stored = await getStoredBytes(file.key);
  if (!stored || stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new CreatorError("Published media is unavailable or changed", 503);
  return stored.bytes;
}
export async function createPublication(sid: string, input: Record<string, unknown>) {
  const db = await requireCreator(sid);
  if (!isSafeId(input.id) || input.confirmed !== true || typeof input.title !== "string" || !input.title.trim() || input.title.length > 120 || typeof input.source_sha256 !== "string") throw new CreatorError("Review the selected content before publishing", 400);
  const id = input.id, request_sha256 = viewHash(input), prior = await db.collection<PublicationDoc>("world_publications").findOne({ _id: id });
  const same = (doc: PublicationDoc) => { if (doc.session_id !== sid || doc.request_sha256 !== request_sha256) throw new CreatorError("Publication identity is already used", 409); return { publication: publicWire(doc), active: doc.active }; };
  if (prior) return same(prior);
  const current = await sources(db, sid), selected = selectPublication(current, input);
  if (sourceHash(current) !== input.source_sha256) throw new CreatorError("The world changed. Review the selection again", 409);
  for (const file of selected.files) await verifiedFile(file);
  return withDbTransaction(async (db, session) => {
    const options = { session }, col = db.collection<PublicationDoc>("world_publications"), prior = await col.findOne({ _id: id }, options);
    if (prior) return same(prior);
    const fresh = await sources(db, sid, session);
    if (sourceHash(fresh) !== input.source_sha256) throw new CreatorError("The world changed during publication", 409);
    if (await col.countDocuments({ session_id: sid, active: true }, options) >= 40) throw new CreatorError("Unpublish an existing snapshot first", 409);
    await db.collection<{ _id: string; publication_fence?: number }>("creator_worlds").updateOne({ _id: sid }, { $inc: { publication_fence: 1 } }, { ...options, upsert: true });
    const doc: PublicationDoc = { _id: id, id, version: 1, session_id: sid, title: (input.title as string).trim(), request_sha256,
      source_sha256: input.source_sha256 as string, created_at: new Date().toISOString(), active: true, ...selected };
    if (Buffer.byteLength(JSON.stringify(doc)) > 8 * 1024 * 1024) throw new CreatorError("Publication metadata exceeds 8 MiB", 413);
    await col.insertOne(doc, options); return { publication: publicWire(doc), active: true };
  });
}
export async function unpublishWorld(sid: string, id: string) {
  const db = await requireCreator(sid);
  if (!isSafeId(id)) throw new CreatorError("Invalid publication", 400);
  return { removed: !!(await db.collection<PublicationDoc>("world_publications").updateOne({ _id: id, session_id: sid }, { $set: { active: false } })).matchedCount };
}
export async function readPublication(id: string) {
  if (!isSafeId(id)) throw new CreatorError("Invalid publication", 400);
  const doc = await (await getDb()).collection<PublicationDoc>("world_publications").findOne({ _id: id, active: true });
  if (!doc) throw new CreatorError("Published world not found", 404); return publicWire(doc);
}
export async function publicationFile(id: string, fileId: string) {
  if (!isSafeId(id) || !isSafeId(fileId)) throw new CreatorError("Invalid publication file", 400);
  const doc = await (await getDb()).collection<PublicationDoc>("world_publications").findOne({ _id: id, active: true });
  const file = doc?.files.find(x => x.id === fileId);
  if (!file) throw new CreatorError("Published file not found", 404);
  return { bytes: await verifiedFile(file), content_type: file.content_type };
}
export async function listWorldPublications() {
  const docs = await (await getDb()).collection<PublicationDoc>("world_publications").find({ active: true }).sort({ created_at: -1 }).limit(60).toArray();
  return docs.map(doc => ({ id: doc.id, title: doc.title, places: doc.scenes.length, views: doc.views.length, videos: doc.videos.length,
    poster: doc.views[0]?.file_id ?? null }));
}
interface PublicationFork { _id: string; publication_id: string; session_id: string; owner_token: string }
/** Copy only the immutable public selection into a new private workspace. No original workspace reads. */
export async function forkPublication(id: string, requestId: string) {
  if (!isSafeId(id) || !isSafeId(requestId)) throw new CreatorError("Invalid publication fork identity", 400);
  const token = await getExistingOwnerToken(); if (!token) throw new CreatorError("Initialize this browser's workspace first", 409);
  const key = viewHash(["publication", token, requestId]), sid = `session_${key}`, db = await getDb();
  const replay = async (db: Db, session?: ClientSession) => {
    const options = session ? { session } : {}, old = await db.collection<PublicationFork>("publication_forks").findOne({ _id: key }, options);
    if (!old) return null;
    if (old.publication_id !== id || old.owner_token !== token) throw new CreatorError("Fork identity already used", 409);
    const owner = await db.collection<{ _id: string; owner_token: string }>("session_owners").findOne({ _id: sid }, options);
    if (owner?.owner_token !== token) throw new CreatorError("Fork ownership unavailable", 403);
    return { session_id: sid };
  };
  const prior = await replay(db); if (prior) return prior;
  const source = await db.collection<PublicationDoc>("world_publications").findOne({ _id: id, active: true });
  if (!source) throw new CreatorError("Published world not found", 404);
  const files: PublicationFile[] = [];
  for (const file of source.files) {
    const bytes = await verifiedFile(file), copied = { ...file, key: `${sid}/publication/${file.id}-${file.sha256}` };
    await uploadJpeg(copied.key, bytes, copied.content_type, AbortSignal.timeout(90_000));
    await verifiedFile(copied); files.push(copied);
  }
  return withDbTransaction(async (db, session) => {
    const prior = await replay(db, session); if (prior) return prior;
    const options = { session }, col = db.collection<PublicationDoc>("world_publications");
    if (!(await col.updateOne({ _id: id, active: true }, { $inc: { fork_fence: 1 } }, options)).matchedCount) throw new CreatorError("Publication was withdrawn", 409);
    if (await db.collection<{ _id: string; [key: string]: unknown }>("session_owners").findOne({ _id: sid }, options)) throw new CreatorError("Fork destination exists", 409);
    const now = new Date();
    let geometry: ReturnType<typeof publicationGeometry>;
    try { geometry = publicationGeometry({ ...source, scenes: source.scenes.map(scene => ({ ...scene, revision: 1 })) }, {
      sessionId: sid, updatedAt: now.toISOString(), sceneIds: Object.fromEntries(source.scenes.map(scene => [scene.place_id, `scene_${viewHash([sid, scene.place_id])}`])),
    }); }
    catch (e) { throw new CreatorError((e as Error).message, 409); }
    for (const scene of geometry.scenes) {
      const doc: SceneDoc = { ...scene, _id: `${sid}:${scene.place_id}` };
      await db.collection<SceneDoc>("place_scenes").insertOne(doc, options);
      await db.collection<SceneDoc>("place_scene_versions").insertOne({ ...doc, _id: `${doc._id}:1` }, options);
    }
    type SceneEntity = Omit<Entity, "updated_at"> & { scene_id: string; updated_at: Date; deleted_at: null };
    const entities: SceneEntity[] = geometry.geos.map(geo => ({ id: geo.entity_id!, scene_id: geo.scene_id!, kind: geo.kind,
      name: geo.label, appearance: geo.visual, aliases: [], facts: ["Published geometry explicitly forked by owner"], state: {},
      reference_image_url: null, first_seen_node_id: null, last_seen_node_id: null, appears_on_node_ids: [], appearance_bboxes: {},
      pinned_by_user: true, confidence: 1, updated_at: now, deleted_at: null }));
    await db.collection<{ _id: string; [key: string]: unknown }>("world_map").insertOne({ _id: sid, entities: geometry.geos,
      bounds: localBounds(toAbsoluteEntities(geometry.geos, geometry.geos)), schema_version: 1, updated_at: now }, options);
    await db.collection<{ _id: string; [key: string]: unknown }>("world_state").insertOne({ _id: sid, entities, schema_version: 1, updated_at: now }, options);
    for (const connection of geometry.connections) await db.collection<ConnectionDoc>("place_connections").insertOne({
      ...connection, _id: `${sid}:${connection.id}`, session_id: sid }, options);
    for (const asset of source.assets) {
      const file = files.find(x => x.id === asset.file_id)!, receipt = source.asset_receipts.find(x => x.kind === asset.kind && x.id === asset.id);
      await db.collection<MeshAssetDoc>(`${asset.kind}_assets`).insertOne({ _id: `${sid}:${asset.id}`, id: asset.id, session_id: sid,
        key: file.key, sha256: file.sha256, bytes: file.bytes, model: "published_snapshot", prompt: "Shared snapshot asset", created_at: now,
        ...(receipt?.geometry ? { geometry: receipt.geometry } : {}), ...(receipt?.image ? { image: receipt.image } : {}) }, options);
    }
    await db.collection<{ _id: string; [key: string]: unknown }>("creator_worlds").insertOne({ _id: sid, title: source.title, visibility: "private", resume_place_id: source.scenes[0]!.place_id,
      resume_node_id: null, last_opened_at: now, published_snapshot: { id, created_at: source.created_at } }, options);
    await db.collection<{ _id: string; [key: string]: unknown }>("publication_libraries").insertOne({ ...source, _id: sid, id: source.id, session_id: sid, files, active: false }, options);
    await db.collection<{ _id: string; [key: string]: unknown }>("session_owners").insertOne({ _id: sid, owner_token: token, created_at: now }, options);
    await db.collection<PublicationFork>("publication_forks").insertOne({ _id: key, publication_id: id, session_id: sid, owner_token: token }, options);
    return { session_id: sid };
  });
}
export async function publicationLibrary(sid: string) {
  const db = await requireCreator(sid), doc = await db.collection<PublicationDoc>("publication_libraries").findOne({ _id: sid });
  if (!doc) throw new CreatorError("No published snapshot library", 404); return publicWire(doc);
}
export async function publicationLibraryFile(sid: string, id: string) {
  const db = await requireCreator(sid), doc = await db.collection<PublicationDoc>("publication_libraries").findOne({ _id: sid }), file = doc?.files.find(x => x.id === id);
  if (!file) throw new CreatorError("Snapshot file not found", 404); return { bytes: await verifiedFile(file), content_type: file.content_type };
}
export async function publicationZip(id: string) {
  if (!isSafeId(id)) throw new CreatorError("Invalid publication", 400);
  const doc = await (await getDb()).collection<PublicationDoc>("world_publications").findOne({ _id: id, active: true });
  if (!doc) throw new CreatorError("Published world not found", 404);
  const zip = new JSZip(), files = [];
  for (const file of doc.files) {
    const name = `files/${file.id}`, bytes = await verifiedFile(file); zip.file(name, bytes);
    files.push({ id: file.id, file: name, sha256: file.sha256, bytes: file.bytes, content_type: file.content_type });
  }
  zip.file("publication.json", JSON.stringify({ format: "openflipbook-publication", version: 1, world: publicWire(doc), files }, null, 2));
  return zip.generateAsync({ type: "uint8array" });
}
