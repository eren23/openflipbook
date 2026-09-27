import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db, Document } from "mongodb";
import type { BuildingSide, Entity, EntityGeoEdit, PlaceSceneDefinition, PlaceSceneSnapshot, WorldEditProposal, WorldEntityGeo, SceneGenerationReceipt } from "@openflipbook/config";
import { getDb, withDbTransaction, type NodeDoc } from "./db";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { emptyPlaceScene, parsePlaceScene, sceneChanges, sceneGeos } from "./place-scene";
import { localBounds, toAbsoluteEntities } from "./world-geometry";
import { placeScenesEnabled } from "./place-scene-enabled";
import { writeSceneVersion, type SceneDoc } from "./place-scene-store";
import { artworkHeadKey, prepareMapAlignmentCorrection, assertMapAlignmentCorrectionCurrent, type MapArtworkHead, type MapArtworkVersion } from "./map-artwork-server";
import type { MapAlignmentCorrection } from "./map-alignment-correction";
import { getExistingOwnerToken } from "./session-owner";
import { adjacentPlacement, edgeLength, OPPOSITE_SIDE } from "./place-connections";
import { checkConnectedSceneEdit, type ConnectionDoc } from "./place-connections-store";
import { floorLocalPoint, placementFloor } from "./floor-placement";
import { savedMeshDimensions } from "./mesh-geometry-server";
import { assertMeshProportions, type MeshDimensions } from "./mesh-dimensions";
import { orientedMeshDimensions } from "./mesh-orientation";
import { materialAssetIds } from "./surface-material";
import { validateMeshShells } from "./mesh-shell-server";
import { requireBuildConnections } from "./place-build-connections";
import type { BuildDoc } from "./place-build-execution";

export type { SceneDoc } from "./place-scene-store";
export interface ProposalDoc extends WorldEditProposal {
  _id: string; session_id: string; place_id: string; source_node_id: string | null; source_image_key: string | null;
  base_hash: string; created_at: Date;
  placement?: WorldEntityGeo;
  generation_source?: SceneGenerationReceipt;
  alignment_source?: MapAlignmentCorrection;
}
interface MapDoc extends Document { _id: string; entities: WorldEntityGeo[]; updated_at: Date }
type SceneEntityDoc = Omit<Entity, "updated_at"> & { updated_at: Date; deleted_at?: Date | null; scene_id?: string };
interface WorldDoc extends Document { _id: string; entities: SceneEntityDoc[]; updated_at: Date }
export const sceneKey = (sid: string, pid: string) => `${sid}:${pid}`;
export const sceneHash = (map: MapDoc | null, world: WorldDoc | null) => createHash("sha256").update(JSON.stringify([map, world])).digest("hex");
export const wireScene = ({ _id: _unused, ...scene }: SceneDoc): PlaceSceneSnapshot => scene;
const wireProposal = (p: ProposalDoc): WorldEditProposal => ({ id: p.id, scene_id: p.scene_id, base_revision: p.base_revision, definition: p.definition, affected_node_ids: p.affected_node_ids, changes: p.changes, ...(p.connection ? { connection: p.connection } : {}), ...(p.generation_source ? { generation_job_id: p.generation_source.job_id } : {}), ...(p.applied_revision ? { applied_revision: p.applied_revision } : {}) });
function validIds(sid: string, pid: string) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(sid) || !isSafeId(pid)) throw new CreatorError("Invalid place", 400);
}
export async function readPlaceScene(sid: string, pid: string) {
  validIds(sid, pid);
  const db = await requireCreator(sid);
  const doc = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) });
  const history = await db.collection<SceneDoc>("place_scene_versions").find({ session_id: sid, place_id: pid }).sort({ revision: -1 }).limit(20).toArray();
  return { scene: doc ? wireScene(doc) : null, history: history.map(wireScene) };
}
export async function savedPlaceContext(sid: string, pid: string) {
  const result = await readPlaceScene(sid, pid);
  if (!result.scene) throw new CreatorError("Saved place not found", 404);
  if (result.scene.source_node_id) return sceneContext(result.scene.source_node_id, pid);
  return { ...result, session_id: sid, place_id: pid, source_node_id: null, source_url: null,
    versions: [], map_artworks: [], parent_source_url: null, initial: result.scene.definition, drawing: null };
}
export async function sceneContext(sourceId: string, placeId?: string, draftId?: string) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(sourceId) || (placeId && !isSafeId(placeId))) throw new CreatorError("Invalid source", 400);
  const db = await getDb();
  const source = await db.collection<NodeDoc>("nodes").findOne({ _id: sourceId });
  if (!source) throw new CreatorError("Saved source image not found", 404);
  await requireCreator(source.session_id);
  // Image edits retain place identity, but a descent/peer is a different place.
  // Session scoping, a visited set and a hop cap bound malformed legacy chains.
  let existing: SceneDoc | null = null, ancestor: NodeDoc | null = source;
  const visited = new Set<string>();
  for (let hop = 0; ancestor && hop < 64; hop++) {
    if (visited.has(ancestor._id)) break;
    visited.add(ancestor._id);
    existing = !placeId ? await db.collection<SceneDoc>("place_scenes").findOne({ session_id: source.session_id, source_node_id: ancestor._id }) : null;
    if (existing || ancestor.relation !== "edit" || !ancestor.parent_id) break;
    ancestor = await db.collection<NodeDoc>("nodes").findOne({ _id: ancestor.parent_id, session_id: source.session_id });
  }
  const pid = placeId || existing?.place_id || `place_${sourceId}`;
  const result = await readPlaceScene(source.session_id, pid);
  if (result.scene && (!result.scene.source_node_id || !visited.has(result.scene.source_node_id))) throw new CreatorError("This image does not belong to the requested place", 409);
  const reference = result.scene?.source_node_id ? await db.collection<NodeDoc>("nodes").findOne({ _id: result.scene.source_node_id, session_id: source.session_id }) : source;
  const parent = reference?.parent_id ? await db.collection<NodeDoc>("nodes").findOne({ _id: reference.parent_id, session_id: source.session_id }) : null;
  const mapHead = parent ? await db.collection<MapArtworkHead>("map_artwork_heads").findOne({ _id: artworkHeadKey(source.session_id, parent._id) }) : null;
  const mapVersions = parent ? await db.collection<MapArtworkVersion>("map_artwork_versions").find({ session_id: source.session_id, map_root_node_id: parent._id }).sort({ created_at: -1 }).limit(30).toArray() : [];
  const mapArtworks = parent ? [{ id: parent._id, title: "Original map", url: `/api/image/${encodeURIComponent(parent._id)}` }, ...mapVersions.map(v => ({ id: v.node_id, title: `Map artwork / geometry r${v.scene_revision}`, url: `/api/image/${encodeURIComponent(v.node_id)}` }))] : [];
  const edits = await db.collection<NodeDoc>("nodes").find({ session_id: source.session_id, parent_id: reference?._id ?? sourceId, relation: "edit" }).sort({ created_at: -1 }).limit(30).toArray();
  const versions = [...new Map([reference, ...edits, source].filter((node): node is NodeDoc => !!node).map(node => [node._id, { id: node._id, title: node.page_title, url: `/api/image/${encodeURIComponent(node._id)}` }])).values()];
  const draft = await db.collection<{ _id: string; state: { scene: { elements: Record<string, unknown>[] }; frame: { width: number; height: number } } }>("sketches").findOne({ session_id: source.session_id, ...(draftId ? { _id: draftId } : { source_node_id: sourceId }) });
  // A source image establishes context, not invented garden geometry or scale.
  // Authored dimensions still require confirmation before the first save.
  const initial = result.scene?.definition ?? { ...emptyPlaceScene(), label: source.page_title?.trim().slice(0, 160) || "New place" };
  return { ...result, versions, map_artworks: mapArtworks, parent_source_url: parent ? `/api/image/${encodeURIComponent(mapHead?.node_id ?? parent._id)}` : null, session_id: source.session_id, place_id: pid, requested_source_node_id: sourceId, requested_source_url: `/api/image/${encodeURIComponent(sourceId)}`, source_node_id: result.scene?.source_node_id ?? sourceId, source_url: result.scene ? `/api/world/${encodeURIComponent(source.session_id)}/places/${encodeURIComponent(pid)}/scene?source=1` : `/api/image/${encodeURIComponent(sourceId)}`, initial, drawing: draft?.state ?? null };
}
// Legacy NL edits use the same revisioned transaction, not a second geometry writer.
export async function applyLegacySceneEdits(sid: string, sceneId: string, edits: EntityGeoEdit[]) {
  const db = await requireCreator(sid);
  const current = await db.collection<SceneDoc>("place_scenes").findOne({ session_id: sid, id: sceneId });
  if (!current) throw new CreatorError("Scene not found", 404);
  const definition = structuredClone(current.definition);
  for (const edit of edits) {
    if (edit.op === "add") throw new CreatorError("Choose a component type in World editor before adding an object", 409);
    const o = definition.objects.find(o => o.id === edit.target);
    if (!o) throw new CreatorError("Edit one local scene at a time in World editor", 409);
    if (edit.op === "move") {
      if (o.placement) {
        const { building } = placementFloor(definition, o.placement);
        const delta = floorLocalPoint({ ...building, x: 0, z: 0 }, { x: edit.dx, z: edit.dy });
        o.x += delta.x; o.z += delta.z;
      } else { o.x += edit.dx; o.z += edit.dy; }
    }
    else if (edit.op === "set_height") o.height = edit.height;
    else if (edit.op === "remove") definition.objects = definition.objects.filter(o => o.id !== edit.target);
    else throw new CreatorError("Use a material swatch in World editor for scene-backed objects", 409);
  }
  const { proposal } = await previewPlaceScene(sid, current.place_id, { base_revision: current.revision, definition });
  return applyPlaceScene(sid, current.place_id, proposal.id);
}
export async function previewPlaceScene(sid: string, pid: string, input: Record<string, unknown>, adjacent?: { source_place_id: string; side: BuildingSide; width: number; source_revision: number }, generation?: SceneGenerationReceipt) {
  validIds(sid, pid);
  const db = await requireCreator(sid);
  const current = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) });
  if (!Number.isSafeInteger(input.base_revision) || input.base_revision !== (current?.revision ?? 0)) throw new CreatorError("This place changed. Reload before previewing.", 409);
  let definition: PlaceSceneDefinition;
  const alignment = input.map_alignment !== undefined ? await prepareMapAlignmentCorrection(sid, pid, input.map_alignment) : null;
  if (alignment && (adjacent || generation || input.generation_job_id !== undefined)) throw new CreatorError("Alignment corrections cannot generate or expand a place", 400);
  if (alignment && alignment.source.draft.scene_revision !== input.base_revision) throw new CreatorError("Geometry changed during alignment preview", 409);
  try { definition = parsePlaceScene(alignment?.definition ?? input.definition); } catch (e) { throw new CreatorError((e as Error).message, 400); }
  if (input.generation_job_id !== undefined) {
    if (!isSafeId(input.generation_job_id)) throw new CreatorError("Invalid generation origin", 400);
    const job = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: `${sid}:${pid}:${input.generation_job_id}` });
    if (!job || job.status !== "ready" || !job.receipt || job.base_revision !== input.base_revision) throw new CreatorError("Generation origin does not match this place revision", 409);
    await requireBuildConnections(db, job);
    const retained = job.receipt.object_ids.filter(id => definition.objects.some(o => o.id === id));
    if (retained.length) generation = { ...job.receipt, object_ids: retained };
  }
  for (const o of definition.objects) if (o.asset_id && !await db.collection<{_id: string; session_id: string}>("mesh_assets").findOne({ _id: `${sid}:${o.asset_id}`, session_id: sid })) throw new CreatorError("Mesh asset does not belong to this world", 403);
  const meshSizes = new Map<string, MeshDimensions>();
  for (const id of materialAssetIds(definition)) if (!await db.collection<{ _id: string; session_id: string }>("material_assets").findOne({ _id: `${sid}:${id}`, session_id: sid })) throw new CreatorError("Material asset does not belong to this world", 403);
  for (const object of definition.objects) if (object.asset_id && object.mesh_scale === "uniform") {
    let size = meshSizes.get(object.asset_id);
    if (!size) { size = await savedMeshDimensions(db, sid, object.asset_id); meshSizes.set(object.asset_id, size); }
    try { assertMeshProportions(orientedMeshDimensions(size, object.mesh_orientation), object); } catch (e) { throw new CreatorError((e as Error).message, 400); }
  }
  const sourceId = current ? current.source_node_id : input.source_node_id;
  if (sourceId !== null && !isSafeId(sourceId)) throw new CreatorError("A saved source or explicit source-free place is required", 400);
  const source = sourceId ? await db.collection<NodeDoc>("nodes").findOne({ _id: sourceId, session_id: sid }) : null;
  if (sourceId && !source) throw new CreatorError("Source not found in this world", 404);
  const map = await db.collection<MapDoc>("world_map").findOne({ _id: sid });
  const world = await db.collection<WorldDoc>("world_state").findOne({ _id: sid });
  const parent = map?.entities.find(e => e.id === pid);
  if (parent && parent.kind !== "place") throw new CreatorError("Target is not a place", 400);
  if (!current && map?.entities.some(e => e.parent_id === pid)) throw new CreatorError("This place already has mapped children. Start from a separate saved place image.", 409);
  const sceneId = current?.id ?? randomUUID();
  for (const o of definition.objects) {
    const geo = map?.entities.find(g => g.id === o.id);
    const entity = world?.entities.find(e => e.id === o.entity_id);
    if ((geo && geo.scene_id !== sceneId) || (entity && entity.scene_id !== sceneId) || (geo && geo.entity_id !== o.entity_id)) throw new CreatorError("Object binding belongs to another place", 409);
  }
  const changes = sceneChanges(current?.definition ?? null, definition);
  if (!changes.length) throw new CreatorError("No world changes to apply", 400);
  changes.push(...await validateMeshShells(db, sid, definition));
  const affected = new Set<string>(sourceId ? [sourceId] : []);
  let frontier = [...affected];
  while (frontier.length) {
    const children = await db.collection<NodeDoc>("nodes").find({ session_id: sid, parent_id: { $in: frontier }, relation: "edit" }).limit(2001).toArray();
    frontier = children.map(child => child._id).filter(id => !affected.has(id));
    for (const id of frontier) affected.add(id);
    if (affected.size > 2000) throw new CreatorError("Too many image revisions to preview this place", 409);
  }
  for (const entity of world?.entities ?? []) if (current?.definition.objects.some(o => o.entity_id === entity.id)) for (const node of entity.appears_on_node_ids) affected.add(node);
  const id = randomUUID();
  const proposal: ProposalDoc = { _id: id, id, scene_id: sceneId, session_id: sid, place_id: pid, source_node_id: sourceId as string | null, source_image_key: current ? current.source_image_key : source?.image_key ?? null, base_revision: current?.revision ?? 0, base_hash: sceneHash(map, world), definition, changes, affected_node_ids: [...affected], created_at: new Date() };
  if (generation) proposal.generation_source = generation;
  if (alignment) {
    proposal.alignment_source = alignment.source;
    proposal.changes.unshift("Manual landmark correction / approximate ground-plane projection");
    for (const id of alignment.source.object_ids) {
      const before = current!.definition.objects.find(o => o.id === id)!, after = definition.objects.find(o => o.id === id)!;
      proposal.changes.push(`${after.label}: (${before.x.toFixed(2)}, ${before.z.toFixed(2)}) -> (${after.x.toFixed(2)}, ${after.z.toFixed(2)}) m; dimensions unchanged`);
    }
  }
  const proposed: PlaceSceneSnapshot = {id:sceneId,session_id:sid,place_id:pid,revision:(current?.revision??0)+1,source_node_id:proposal.source_node_id,source_image_key:proposal.source_image_key,definition,updated_at:proposal.created_at.toISOString()};
  if(adjacent){
    if(current)throw new CreatorError("Adjoining place already exists",409);
    const sourceScene=await db.collection<SceneDoc>("place_scenes").findOne({_id:sceneKey(sid,adjacent.source_place_id)});
    if(!sourceScene||sourceScene.revision!==adjacent.source_revision)throw new CreatorError("Source place changed. Reload before expanding.",409);
    try {proposal.placement=adjacentPlacement(sourceScene,proposed,adjacent.side,map?.entities??[]);}
    catch(e){throw new CreatorError((e as Error).message,409);}
    proposal.connection={id:randomUUID(),version:1,kind:"boundary",created_at:proposed.updated_at,width:adjacent.width,
      a:{place_id:sourceScene.place_id,side:adjacent.side,offset:edgeLength(sourceScene.definition,adjacent.side)/2},
      b:{place_id:pid,side:OPPOSITE_SIDE[adjacent.side],offset:edgeLength(definition,OPPOSITE_SIDE[adjacent.side])/2}};
    proposal.changes.push(`Connect ${sourceScene.definition.label} ${adjacent.side} boundary (${adjacent.width} m opening)`);
  }
  const incoming=sceneGeos(proposed,[...(map?.entities??[]),...(proposal.placement?[proposal.placement]:[])]);
  const replaced=new Set(incoming.map(g=>g.id));
  const nextGeos=[...(map?.entities??[]).filter(g=>g.scene_id!==sceneId&&!replaced.has(g.id)),...incoming];
  await checkConnectedSceneEdit(db,sid,proposed,nextGeos,undefined,proposal.connection);
  await db.collection<ProposalDoc>("world_edit_proposals").insertOne(proposal);
  return { proposal: wireProposal(proposal) };
}
export async function previewAdjacentPlace(sid: string, sourcePid: string, input: Record<string, unknown>) {
  validIds(sid,sourcePid);
  const side=input.side as BuildingSide;
  if(!OPPOSITE_SIDE[side]||!Number.isSafeInteger(input.source_revision)||typeof input.width!=="number"||!Number.isFinite(input.width))throw new CreatorError("Invalid boundary request",400);
  const pid=`place_${randomUUID()}`;
  const result=await previewPlaceScene(sid,pid,{base_revision:0,source_node_id:null,definition:input.definition},{source_place_id:sourcePid,side,width:input.width,source_revision:Number(input.source_revision)});
  return {...result,place_id:pid};
}
export async function applyPlaceScene(sid: string, pid: string, proposalId: unknown) {
  validIds(sid, pid);
  if (!isSafeId(proposalId)) throw new CreatorError("Invalid proposal", 400);
  await requireCreator(sid);
  return withDbTransaction((db, session) => commitPlaceScene(db, session, sid, pid, proposalId));
}

// Creation and later edits share exactly the same canonical geometry writer.
export async function commitPlaceScene(db: Db, session: ClientSession, sid: string, pid: string, proposalId: string) {
    const options = { session };
    const proposals = db.collection<ProposalDoc>("world_edit_proposals");
    const p = await proposals.findOne({ _id: proposalId, session_id: sid, place_id: pid }, options);
    if (!p) throw new CreatorError("Proposal not found", 404);
    if (p.applied_revision) {
      const old = await db.collection<SceneDoc>("place_scene_versions").findOne({ _id: `${sceneKey(sid, pid)}:${p.applied_revision}` }, options);
      if (!old) throw new CreatorError("Applied revision unavailable", 409);
      return { scene: wireScene(old), proposal: wireProposal(p) };
    }
    const current = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) }, options);
    const maps = db.collection<MapDoc>("world_map"), worlds = db.collection<WorldDoc>("world_state");
    const map = await maps.findOne({ _id: sid }, options), world = await worlds.findOne({ _id: sid }, options);
    if ((current?.revision ?? 0) !== p.base_revision || sceneHash(map, world) !== p.base_hash) throw new CreatorError("The world changed after preview. Review a fresh proposal.", 409);
    if (p.alignment_source) await assertMapAlignmentCorrectionCurrent(db, session, sid, pid, p.alignment_source);
    if (p.generation_source) await requireBuildConnections(db, { ...p.generation_source, session_id: sid, place_id: pid }, session);
    const now = new Date(Math.max(Date.now(), (map?.updated_at?.getTime() ?? 0) + 1, (world?.updated_at?.getTime() ?? 0) + 1));
    const scene: SceneDoc = { _id: sceneKey(sid, pid), id: p.scene_id, session_id: sid, place_id: pid, revision: p.base_revision + 1, source_node_id: p.source_node_id, source_image_key: p.source_image_key, definition: p.definition, updated_at: now.toISOString() };
    const sources = [...(current?.generation_sources ?? []), ...(p.generation_source ? [p.generation_source] : [])];
    if (sources.length) scene.generation_sources = sources;
    const incoming = sceneGeos(scene, [...(map?.entities ?? []),...(p.placement?[p.placement]:[])]);
    const replaced = new Set(incoming.map(g => g.id));
    const removed = new Set(current?.definition.objects.filter(o => !p.definition.objects.some(n => n.id === o.id)).map(o => o.entity_id) ?? []);
    const geos = [...(map?.entities ?? []).filter(g => g.scene_id !== scene.id && !replaced.has(g.id)), ...incoming];
    await checkConnectedSceneEdit(db,sid,scene,geos,session,p.connection);
    const entities = (world?.entities ?? []).map(e => removed.has(e.id) ? { ...e, deleted_at: now, updated_at: now } : e);
    for (const geo of incoming) {
      if (!geo.entity_id) continue;
      const at = entities.findIndex(e => e.id === geo.entity_id), previous = entities[at];
      const entity: SceneEntityDoc = previous ? { ...previous, scene_id: scene.id, name: geo.label, appearance: geo.visual, pinned_by_user: true, deleted_at: null, updated_at: now } : {
        id: geo.entity_id, scene_id: scene.id, kind: geo.kind, name: geo.label, appearance: geo.visual, aliases: [], facts: [sources.some(s => s.object_ids.includes(geo.id)) ? "AI-proposed architecture, explicitly accepted by owner" : "User-authored local scene"], state: {}, reference_image_url: null,
        first_seen_node_id: p.source_node_id, last_seen_node_id: p.source_node_id, appears_on_node_ids: p.source_node_id ? [p.source_node_id] : [], appearance_bboxes: {}, pinned_by_user: true, confidence: 1, updated_at: now,
      };
      if (at >= 0) entities[at] = entity; else entities.push(entity);
    }
    await maps.replaceOne({ _id: sid }, { ...map, _id: sid, entities: geos, bounds: localBounds(toAbsoluteEntities(geos, geos)), schema_version: 1, updated_at: now }, { ...options, upsert: true });
    await worlds.replaceOne({ _id: sid }, { ...world, _id: sid, entities, schema_version: 1, updated_at: now }, { ...options, upsert: true });
    await writeSceneVersion(db, session, scene);
    if(p.connection)await db.collection<ConnectionDoc>("place_connections").insertOne({...p.connection,_id:`${sid}:${p.connection.id}`,session_id:sid},options);
    await db.collection<NodeDoc>("nodes").updateMany({ session_id: sid, _id: { $in: p.affected_node_ids } }, { $set: { scene_outdated: true } }, options);
    await proposals.updateOne({ _id: p._id }, { $set: { applied_revision: scene.revision } }, options);
    return { scene: wireScene(scene), proposal: wireProposal({ ...p, applied_revision: scene.revision }) };
}

/** A client-minted UUID survives a lost response; retries cannot create another world. */
export async function createPlaceWorld(input: Record<string, unknown>) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new CreatorError("Persistence is not configured", 503);
  if (typeof input.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id)) throw new CreatorError("Invalid creation request", 400);
  let definition: PlaceSceneDefinition;
  try { definition = parsePlaceScene(input.definition); } catch (e) { throw new CreatorError((e as Error).message, 400); }
  if (definition.objects.some(o => o.asset_id) || materialAssetIds(definition).length) throw new CreatorError("Save the world before adding generated assets", 400);
  const sid = `session_${input.request_id.toLowerCase()}`, pid = "place_root";
  const token = await getExistingOwnerToken();
  if (!token) throw new CreatorError("Initialize this browser's workspace before creating a world", 409);
  const hash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  return withDbTransaction(async (db, session) => {
    const options = { session };
    const owners = db.collection<{ _id: string; owner_token: string; created_at: Date }>("session_owners");
    const metadata = db.collection<{ _id: string; creation_hash: string; title: string; resume_place_id: string; last_opened_at: Date; visibility: "private" }>("creator_worlds");
    const owner = await owners.findOne({ _id: sid }, options);
    if (owner) {
      if (owner.owner_token !== token) throw new CreatorError("This world is not owned by this browser", 403);
      const receipt = await metadata.findOne({ _id: sid }, options);
      if (receipt?.creation_hash !== hash) throw new CreatorError("Creation request already used. Reload the saved world.", 409);
      const scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: sceneKey(sid, pid) }, options);
      if (!scene) throw new CreatorError("Created place is unavailable", 409);
      return { scene: wireScene(scene), session_id: sid, place_id: pid };
    }
    // Do not claim a legacy or partially populated world through the creation route.
    for (const name of ["nodes", "place_scenes"]) if (await db.collection(name).findOne({ session_id: sid }, options)) throw new CreatorError("World id already exists", 409);
    for (const name of ["world_map", "world_state", "creator_worlds"]) if (await db.collection<{ _id: string }>(name).findOne({ _id: sid }, options)) throw new CreatorError("World id already exists", 409);
    const now = new Date(), id = randomUUID();
    await owners.insertOne({ _id: sid, owner_token: token, created_at: now }, options);
    await metadata.insertOne({ _id: sid, creation_hash: hash, title: definition.label, resume_place_id: pid, last_opened_at: now, visibility: "private" }, options);
    await db.collection<ProposalDoc>("world_edit_proposals").insertOne({ _id: id, id, scene_id: randomUUID(), session_id: sid, place_id: pid,
      source_node_id: null, source_image_key: null, base_revision: 0, base_hash: sceneHash(null, null), definition,
      changes: sceneChanges(null, definition), affected_node_ids: [], created_at: now }, options);
    const result = await commitPlaceScene(db, session, sid, pid, id);
    return { scene: result.scene, session_id: sid, place_id: pid };
  });
}
