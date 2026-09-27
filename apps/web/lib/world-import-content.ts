import type { Document } from "mongodb";
import type { PlaceSceneDefinition, WorldEntityGeo, PlaceConnection } from "@openflipbook/config";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { archiveHash, archiveList, archiveObject, invalidArchive, type WorldArchive } from "./world-import-archive";
import { isSafeId } from "./ids";
import { parsePlaceScene } from "./place-scene";
import type { SceneDoc } from "./place-scene-store";
import { validateConnections } from "./place-connections";
import { materialAssetIds } from "./surface-material";
import { inspectMeshImport } from "./mesh-import";
import { withMeshGeometry } from "./mesh-geometry";
import { fitGeneratedMesh } from "./mesh-transform";
import { inspectMeshShell } from "./mesh-shell";
import { assertMeshProportions, type MeshDimensions } from "./mesh-dimensions";
import { orientedMeshDimensions } from "./mesh-orientation";
import { VIEW_PASSES, objectMaskColor } from "./place-view";
import { parseCaptureMetadata } from "./place-view-server";
import type { PlaceViewDoc } from "./place-view-store";
import { illustrationDependency } from "./illustration-input";
import { remapTransition } from "./transition-context";
import { parseWalkPose } from "./walk-position";
import { validateImportedMapArtwork } from "./world-import-map";
import { importWorldMotion } from "./world-import-motion";
import type { WorldImportPlan } from "./world-import-plan";
export type { WorldImportPlan } from "./world-import-plan";

const id = (value: unknown): string => isSafeId(value) ? value : invalidArchive("Invalid archive identity");
const string = (v: unknown, cap = 20000): string => typeof v === "string" && v.length <= cap ? v : invalidArchive("Invalid archive text");
const date = (v: unknown): Date => { const d = new Date(string(v, 40)); if (!Number.isFinite(d.getTime())) return invalidArchive("Invalid archive timestamp"); return d; };
const integer = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 1 ? Number(v) : invalidArchive("Invalid archive revision");
const finite = (v: unknown, cap = 1e8): boolean => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= cap;
const rows = (archive: WorldArchive, name: string, cap = 5000) => archiveList(archive.json(name), cap).map(archiveObject);

export async function prepareWorldImport(archive: WorldArchive, sid: string): Promise<WorldImportPlan> {
  id(sid); const sourceSid = id(archive.manifest.session_id);
  const records: Record<string, Document[]> = {}, uploads: WorldImportPlan["uploads"] = [], uploaded = new Map<string, string>();
  const add = (collection: string, doc: Document) => { (records[collection] ??= []).push(doc); };
  const json = (name: string) => archiveObject(archive.json(name));
  const nodes = archiveList(json("graph.json").nodes, 500).map(archiveObject);
  const nodeIds = new Map(nodes.map(n => [id(n.id), archiveHash(`${sid}:node:${id(n.id)}`)]));
  if (nodeIds.size !== nodes.length) invalidArchive("Duplicate page identities");
  const node = (v: unknown): string | null => v == null ? null : nodeIds.get(id(v)) ?? invalidArchive("Page reference is outside the archive");
  const imageKeys = new Map<string, string>();
  function bytes(path: unknown): Buffer { return archive.files.get(string(path, 500)) ?? invalidArchive("Referenced archive bytes are missing"); }
  function file(path: unknown, contentType: string, sha256?: unknown): string {
    const p = string(path, 500), data = bytes(p), hash = archiveHash(data);
    if (sha256 !== undefined && hash !== sha256) invalidArchive("Saved asset hash differs from its archived bytes");
    const prior = uploaded.get(p); if (prior) return prior;
    const key = `${sid}/restored/${hash}`; uploaded.set(p, key); uploads.push({ key, bytes: data, contentType }); return key;
  }
  async function raster(path: unknown, expected?: { width: number; height: number }, allowed = ["png", "jpeg", "webp"]) {
    const image = sharp(bytes(path), { limitInputPixels: 16_777_216, failOn: "warning" }); const info = await image.metadata();
    if (!info.width || !info.height || !allowed.includes(info.format ?? "") || (info.pages ?? 1) !== 1 || expected && (info.width !== expected.width || info.height !== expected.height)) return invalidArchive("Invalid archived image or camera dimensions");
    await image.stats(); return `image/${info.format}`;
  }
  for (const n of nodes) {
    const key = string(n.image_key, 1000), saved = file(n.image, await raster(n.image));
    if (imageKeys.has(key) && imageKeys.get(key) !== saved) invalidArchive("One source image key has conflicting bytes");
    imageKeys.set(key, saved);
  }
  for (const ref of rows(archive, "references.json", 500)) {
    const key = string(ref.image_key, 1000), saved = file(ref.image, await raster(ref.image));
    if (imageKeys.has(key) && imageKeys.get(key) !== saved) invalidArchive("One source image key has conflicting bytes");
    imageKeys.set(key, saved);
  }
  const imageKey = (v: unknown): string | null => v == null ? null : imageKeys.get(string(v, 1000)) ?? invalidArchive("Image reference is not bundled in the archive");
  function acyclic(items: Record<string, unknown>[]) {
    const parents = new Map(items.map(item => [id(item.id), item.parent_id == null ? null : id(item.parent_id)]));
    if (parents.size !== items.length) invalidArchive("Duplicate world identities");
    const complete = new Set<string>();
    for (const start of parents.keys()) { const seen = new Set<string>(); let p: string | null = start; while (p && !complete.has(p)) {
      if (seen.has(p) || !parents.has(p)) invalidArchive("World contains a cyclic or dangling parent"); seen.add(p); p = parents.get(p)!;
    } for (const item of seen) complete.add(item); }
  }
  acyclic(nodes);
  for (const n of nodes) {
    if (n.descent_video_url) invalidArchive("Arrival video bytes are not bundled in this archive");
    const { image: _image, id: _id, title: _title, ...metadata } = n;
    const sceneView = n.scene_view == null ? null : archiveObject(n.scene_view);
    const transition = n.transition_context == null ? null : archiveObject(n.transition_context);
    if (transition?.source_node_id) node(transition.source_node_id);
    add("nodes", { ...metadata, _id: node(n.id), session_id: sid, parent_id: node(n.parent_id), image_key: imageKey(n.image_key),
      query: string(n.query), page_title: string(n.page_title ?? n.title, 1000), image_model: string(n.image_model, 500), prompt_author_model: string(n.prompt_author_model, 500), aspect_ratio: string(n.aspect_ratio, 40),
      final_prompt: n.final_prompt == null ? null : string(n.final_prompt), created_at: date(n.created_at), geo_extracted_at: n.geo_extracted_at == null ? null : date(n.geo_extracted_at),
      scene_view: sceneView ? { ...sceneView, ...(sceneView.node_id ? { node_id: node(sceneView.node_id) } : {}) } : null,
      transition_context: transition ? { ...remapTransition(transition as never, nodeIds), source_image_key: imageKey(transition.source_image_key) } : null,
      restored_from: { session_id: sourceSid, node_id: n.id, archive_sha256: archive.sha256 } });
  }
  const rawMap = json("world-map.json"), geos = archiveList(rawMap.entities, 10000).map(archiveObject);
  acyclic(geos);
  for (const g of geos) {
    const pos = archiveObject(g.pos), footprint = archiveObject(g.footprint);
    if (![pos.x, pos.y, footprint.w, footprint.d, g.height].every(v => finite(v)) || Number(footprint.w) <= 0 || Number(footprint.d) <= 0 || Number(g.height) < 0 || g.scale !== undefined && (!finite(g.scale) || Number(g.scale) <= 0)) invalidArchive("Invalid map geometry");
    id(g.id); string(g.label, 1000);
    if (g.identity_anchor) { const anchor = archiveObject(g.identity_anchor); g.identity_anchor = { ...anchor, node_id: node(anchor.node_id), image_key: imageKey(anchor.image_key) }; }
  }
  add("world_map", { ...rawMap, _id: sid, session_id: sid, entities: geos, updated_at: date(rawMap.updated_at) });
  const registryRaw = archive.json("entity-registry.json");
  if (registryRaw) {
    const registry = archiveObject(registryRaw), entities = archiveList(registry.entities, 10000).map(archiveObject);
    const seen = new Set<string>();
    for (const e of entities) {
      if (seen.has(id(e.id))) invalidArchive("Duplicate entity identity"); seen.add(id(e.id));
      if (e.reference_image_url) invalidArchive("Entity reference image bytes must be bundled before restore");
      e.first_seen_node_id = node(e.first_seen_node_id); e.last_seen_node_id = node(e.last_seen_node_id);
      e.appears_on_node_ids = archiveList(e.appears_on_node_ids).map(node);
      for (const field of ["appearance_bboxes", "appearance_borders"]) if (e[field]) e[field] = Object.fromEntries(Object.entries(archiveObject(e[field])).map(([key, v]) => [node(key)!, v]));
      e.updated_at = date(e.updated_at); if (e.deleted_at) e.deleted_at = date(e.deleted_at);
    }
    add("world_state", { ...registry, _id: sid, entities, updated_at: date(registry.updated_at) });
  }
  if (rows(archive, "material-packs.json").length) invalidArchive("Legacy atlas bundles require migration before portable restore");
  const scenes: SceneDoc[] = [];
  const versions = new Map<string, SceneDoc>();
  for (const s of rows(archive, "place-scenes.json")) {
    const normalized = parsePlaceScene(s.definition);
    if (!isDeepStrictEqual(normalized, s.definition) || normalized.material_pack) invalidArchive("Scene definition requires explicit migration before restore");
    const definition = s.definition as PlaceSceneDefinition;
    const key = `${id(s.place_id)}:${integer(s.revision)}`; if (versions.has(key)) invalidArchive("Duplicate scene revision");
    const doc = { ...s, _id: `${sid}:${key}`, id: id(s.id), session_id: sid, place_id: id(s.place_id), revision: integer(s.revision), definition,
      source_node_id: node(s.source_node_id), source_image_key: imageKey(s.source_image_key), updated_at: date(s.updated_at).toISOString() } as SceneDoc;
    versions.set(key, doc); add("place_scene_versions", doc);
  }
  for (const s of rows(archive, "place-scene-heads.json")) {
    const version = versions.get(`${id(s.place_id)}:${integer(s.revision)}`);
    if (!version || version.id !== s.id || !isDeepStrictEqual(version.definition, s.definition) || scenes.some(scene => scene.place_id === s.place_id)) return invalidArchive("Current scene does not match its archived revision");
    const doc = { ...version, _id: `${sid}:${version.place_id}` }; scenes.push(doc); add("place_scenes", doc);
  }
  if (!nodes.length && !scenes.length) invalidArchive("Archive contains no world");
  const connections = rows(archive, "place-connections.json", 256) as unknown as PlaceConnection[];
  validateConnections(connections, scenes, geos as unknown as WorldEntityGeo[]);
  for (const c of connections) add("place_connections", { ...c, _id: `${sid}:${id(c.id)}`, session_id: sid });
  const assets = new Map<string, Document>();
  for (const kind of ["mesh", "material"] as const) {
    for (const a of rows(archive, kind === "mesh" ? "mesh-assets.json" : "surface-materials.json")) {
      const aid = id(a.id); if (assets.has(`${kind}:${aid}`)) invalidArchive("Duplicate asset identity");
      const contentType = kind === "mesh" ? "model/gltf-binary" : await raster(a.file, undefined, ["jpeg"]);
      const geometry = kind === "mesh" ? { sha256: a.sha256, size: (await inspectMeshImport(bytes(a.file))).size } : undefined;
      const { file: _file, missing: _missing, image_input, ...metadata } = a;
      const doc: Document = { ...metadata, id: aid, _id: `${sid}:${aid}`, session_id: sid, key: file(a.file, contentType, a.sha256), bytes: bytes(a.file).length,
        model: string(a.model, 500), prompt: string(a.prompt), created_at: date(a.created_at), ...(geometry ? { geometry } : {}) };
      if (image_input) {
        const source = archiveObject(image_input), original = archiveObject(source.original), sourceId = id(source.id);
        const { file: _sourceFile, original: _original, ...sourceMetadata } = source;
        const sourceDoc = { ...sourceMetadata, _id: `${sid}:${sourceId}`, session_id: sid, created_at: doc.created_at,
          key: file(source.file, await raster(source.file, { width: Number(source.width), height: Number(source.height) }, ["png"]), source.sha256), bytes: bytes(source.file).length,
          original: { key: file(original.file, await raster(original.file), original.sha256), sha256: original.sha256, bytes: bytes(original.file).length, content_type: original.content_type } };
        doc.image_input = sourceDoc;
        const existing = records.mesh_sources?.find(s => s.id === sourceId);
        if (existing && !isDeepStrictEqual({ ...existing, created_at: null }, { ...sourceDoc, created_at: null })) invalidArchive("Mesh concepts have conflicting identities");
        if (!existing) add("mesh_sources", sourceDoc);
      }
      assets.set(`${kind}:${aid}`, doc); add(`${kind}_assets`, doc);
    }
  }
  for (const s of versions.values()) {
    for (const object of s.definition.objects) if (object.asset_id) {
      const asset = assets.get(`mesh:${object.asset_id}`); if (!asset) invalidArchive("Scene references a missing mesh");
      if (object.mesh_scale === "uniform") assertMeshProportions(orientedMeshDimensions(asset!.geometry.size as MeshDimensions, object.mesh_orientation), object);
      if (object.kind === "building") { const data = uploads.find(u => u.key === asset!.key)!.bytes; await withMeshGeometry(data, model => inspectMeshShell(fitGeneratedMesh(model, object), object)); }
    }
    for (const material of materialAssetIds(s.definition)) if (!assets.has(`material:${material}`)) invalidArchive("Scene references a missing material");
  }
  const artwork = validateImportedMapArtwork(json("map-artwork.json"), nodes, [...versions.values()]);
  for (const v of artwork.versions) {
    const scene = versions.get(`${id(v.place_id)}:${integer(v.scene_revision)}`)!;
    if (scene.source_node_id !== node(v.scene_source_node_id)) invalidArchive("Map artwork source differs from its saved scene");
    add("map_artwork_versions", { ...v, _id: node(v.node_id), node_id: node(v.node_id), session_id: sid,
      scene_source_node_id: node(v.scene_source_node_id), map_root_node_id: node(v.map_root_node_id), base_map_node_id: node(v.base_map_node_id), created_at: date(v.created_at) });
  }
  for (const h of artwork.heads) add("map_artwork_heads", { ...h, _id: `${sid}:${node(h.map_root_node_id)}`, session_id: sid, node_id: node(h.node_id), map_root_node_id: node(h.map_root_node_id) });
  for(const d of artwork.drafts){
    const scene=versions.get(`${id(d.place_id)}:${integer(d.scene_revision)}`)!;
    if(scene.source_node_id!==node(d.scene_source_node_id))invalidArchive("Map alignment source differs from its saved scene");
    await raster(nodes.find(n=>n.id===d.map_node_id)!.image,d.frame);
    add("map_alignment_drafts",{...d,_id:`${sid}:${d.place_id}`,session_id:sid,map_node_id:node(d.map_node_id),scene_source_node_id:node(d.scene_source_node_id),updated_at:date(d.updated_at)});
  }
  for (const entry of rows(archive, "place-views.json", 500)) {
    const capture = archiveObject(entry.capture_metadata), vid = id(capture.id);
    if (["_id", "session_id", "files", "accepted_illustration_id", "historical"].some(key => key in capture)) invalidArchive("Invalid camera recovery fields");
    if (records.place_views?.some(v => v.id === vid)) invalidArchive("Duplicate saved camera");
    const sources = archiveList(capture.sources, 16).map(archiveObject).map(s => {
      const scene = versions.get(`${id(s.place_id)}:${integer(s.revision)}`);
      if (!scene || scene.id !== s.scene_id || archiveHash(JSON.stringify(scene.definition)) !== s.definition_sha256) return invalidArchive("Saved camera geometry binding is incomplete");
      return { scene_id: scene.id, place_id: scene.place_id, revision: scene.revision, definition: scene.definition, x: s.x, z: s.z };
    });
    parseCaptureMetadata({ ...capture, sources, passes: Object.fromEntries(VIEW_PASSES.map(pass => [pass, ""])) });
    if (capture.provenance !== "client_rendered_saved_geometry" || !sources.some(s => s.place_id === capture.root_place_id)) invalidArchive("Camera source place is missing");
    const expectedAssets = [];
    for (const kind of ["mesh", "material"] as const) {
      const ids = [...new Set(sources.flatMap(s => kind === "mesh" ? s.definition.objects.flatMap(o => o.asset_id ? [o.asset_id] : []) : materialAssetIds(s.definition)))].sort();
      for (const aid of ids) { const asset = assets.get(`${kind}:${aid}`); if (!asset) invalidArchive("Camera source asset is missing"); expectedAssets.push({ kind, id: aid, sha256: asset!.sha256 }); }
    }
    if (!isDeepStrictEqual(capture.assets, expectedAssets)) invalidArchive("Camera asset binding is incomplete");
    const objectIds = sources.flatMap(s => s.definition.objects.map(o => o.id)).sort();
    if (new Set(objectIds).size !== objectIds.length || !isDeepStrictEqual(capture.objects, objectIds.map((object_id, i) => ({ object_id, rgb: objectMaskColor(i) })))) invalidArchive("Camera object identities differ from its geometry");
    if (capture.floor_id && !sources.some(s => s.definition.objects.some(o => o.structure?.floors.some(f => f.id === capture.floor_id)))) invalidArchive("Camera floor is missing");
    const passes = archiveList(entry.passes, 4).map(archiveObject), files = {} as PlaceViewDoc["files"];
    if (passes.length !== 4) invalidArchive("Saved camera passes are incomplete");
    for (const pass of VIEW_PASSES) {
      const p = passes.find(p => p.pass === pass); if (!p) invalidArchive("Saved camera pass is missing");
      const type = await raster(p!.file, { width: Number(capture.width), height: Number(capture.height) }, ["png"]);
      files[pass] = { key: file(p!.file, type, p!.sha256), sha256: String(p!.sha256), bytes: bytes(p!.file).length };
    }
    const doc = { ...capture, _id: `${sid}:${vid}`, session_id: sid, files,
      ...(entry.accepted_illustration_id ? { accepted_illustration_id: id(entry.accepted_illustration_id) } : {}) } as unknown as PlaceViewDoc;
    id(doc.root_place_id); date(doc.created_at); string(doc.label, 120);
    if (!scenes.some(s => s.place_id === doc.root_place_id) || !/^[a-f0-9]{64}$/.test(doc.request_sha256)) invalidArchive("Saved camera recovery metadata is incomplete");
    const dependency = illustrationDependency(doc), illustrations = archiveList(entry.illustrations ?? [], 50).map(archiveObject);
    for (const a of illustrations) {
      if (!isDeepStrictEqual(a.view_dependency, dependency)) invalidArchive("Illustration fingerprint does not match its saved camera");
      const type = await raster(a.file, { width: doc.width, height: doc.height }, ["png", "jpeg"]);
      if (records.illustration_assets?.some(asset => asset.id === a.id)) invalidArchive("Duplicate illustration identity");
      const { file: _file, accepted: _accepted, historical: _historical, ...metadata } = a;
      add("illustration_assets", { ...metadata, _id: `${sid}:${id(a.id)}`, id: id(a.id), session_id: sid, key: file(a.file, type, a.sha256), bytes: bytes(a.file).length,
        content_type: type, created_at: date(a.created_at), illustration: { width: doc.width, height: doc.height, color_space: "srgb" } });
    }
    if (doc.accepted_illustration_id && !illustrations.some(a => a.id === doc.accepted_illustration_id)) invalidArchive("Accepted artwork is missing");
    add("place_views", doc);
  }
  for (const view of records.place_views ?? []) if (view.refreshed_from && !(records.place_views ?? []).some(source => source.id === view.refreshed_from && source.root_place_id === view.root_place_id)) invalidArchive("Saved camera refresh history is missing");
  await importWorldMotion(archive, sid, records, uploads);
  const workspaceRaw = archive.json("workspace.json"), workspace = workspaceRaw ? archiveObject(workspaceRaw) : {};
  const title = string(workspace.title ?? scenes[0]?.definition.label ?? nodes[0]?.title ?? "Imported world", 160);
  let walk_position;
  if (workspace.walk_position) {
    const saved = archiveObject(workspace.walk_position), pose = saved.pose === null ? null : parseWalkPose(saved.pose);
    if (saved.pose !== null && !pose) invalidArchive("Invalid saved walking position");
    walk_position = { revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0, pose };
  }
  const resumePlace = workspace.resume_place_id == null ? null : id(workspace.resume_place_id);
  if (resumePlace && !scenes.some(s => s.place_id === resumePlace)) invalidArchive("Resume place is unavailable");
  add("creator_worlds", { _id: sid, title, visibility: "private", archived: false, last_opened_at: new Date(), resume_node_id: node(workspace.resume_node_id), resume_place_id: resumePlace ?? (!nodes.length ? scenes[0]?.place_id : null),
    ...(walk_position ? { walk_position } : {}), ...(workspace.resume_view === "walk" ? { resume_view: "walk" } : {}),
    imported_from: { session_id: sourceSid, archive_sha256: archive.sha256, provenance: "user_supplied_archive" } });
  return { session_id: sid, title, records, uploads, preview: { title, source_session_id: sourceSid, pages: nodes.length, places: scenes.length,
    objects: scenes.reduce((n, s) => n + s.definition.objects.length, 0), meshes: records.mesh_assets?.length ?? 0, materials: records.material_assets?.length ?? 0,
    views: records.place_views?.length ?? 0, illustrations: records.illustration_assets?.length ?? 0, motion_studies: records.motion_studies?.length ?? 0, clips: records.motion_assets?.length ?? 0 } };
}
