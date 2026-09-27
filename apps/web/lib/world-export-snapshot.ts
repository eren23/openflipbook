import type { Db, ClientSession, Document, Filter } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { withDbTransaction, type NodeDoc } from "./db";
import { getExistingOwnerToken } from "./session-owner";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";
import type { SceneDoc } from "./place-scene-store";
import type { MapArtworkHead, MapArtworkVersion } from "./map-artwork-server";
import type { MeshAssetDoc } from "./mesh-execution";
import type { WorldEntityGeo } from "@openflipbook/config";
import { materialAssetIds } from "./surface-material";
import { readConnectionGraph } from "./place-connection-graph";
import { snapshotPlaceViewExports } from "./place-view-server";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionReviewDoc } from "./motion-job";
import type { MapAlignmentDraft } from "./map-alignment";

export const WORLD_EXPORT_NODE_CAP = 500;
const RECORD_CAP = 5000;
const METADATA_BYTES = 32 * 1024 * 1024;
interface RegistryDoc extends Document { _id: string; entities: (Document & { deleted_at?: Date | null })[] }
interface MapDoc extends Document { _id: string; entities: WorldEntityGeo[] }
interface CreatorMetadata extends Document { _id: string; visibility?: string }

// No storage/model calls inside this transaction. Every authorization and
// metadata read sees the same committed world, even while an edit is applied.
export async function snapshotWorldExport(sid: string) {
  if (!isSafeId(sid)) throw new CreatorError("Invalid world identity", 400);
  const token = await getExistingOwnerToken();
  return withDbTransaction(async (db: Db, session: ClientSession) => {
    const options = { session };
    let metadataBytes = 0;
    function account<T>(value: T): T {
      metadataBytes += Buffer.byteLength(JSON.stringify(value));
      if (metadataBytes > METADATA_BYTES) throw new CreatorError("World metadata export exceeds 32 MiB", 413);
      return value;
    }
    async function rows<T extends Document>(name: string, cap = RECORD_CAP, filter: Document = { session_id: sid }) {
      const result = await db.collection<T>(name).find(filter as Filter<T>, options).sort({ created_at: 1, _id: 1 }).limit(cap + 1).toArray();
      if (result.length > cap) throw new CreatorError(`World export exceeds ${cap} ${name} records; nothing was exported`, 413);
      return account(result);
    }
    const owner = await db.collection<{ _id: string; owner_token: string }>("session_owners").findOne({ _id: sid }, options);
    const privateOwner = Boolean(token && owner?.owner_token === token);
    const metadata = await db.collection<CreatorMetadata>("creator_worlds").findOne({ _id: sid }, options);
    if (metadata?.visibility === "private" && !privateOwner) throw new CreatorError("This world is not owned by this browser", 403);
    const nodes = await rows<NodeDoc>("nodes", WORLD_EXPORT_NODE_CAP);
    const heads = await rows<SceneDoc>("place_scenes");
    if (!nodes.length && !heads.length) throw new CreatorError("World not found or empty", 404);
    if (!nodes.length && !privateOwner) throw new CreatorError("This world is not owned by this browser", 403);
    const scenes = await rows<SceneDoc>("place_scene_versions");
    scenes.sort((a, b) => a.place_id.localeCompare(b.place_id) || a.revision - b.revision);
    for (const head of heads) {
      const version = scenes.find(s => s.place_id === head.place_id && s.revision === head.revision);
      if (!version || version.id !== head.id || !isDeepStrictEqual(version.definition, head.definition)
        || version.source_node_id !== head.source_node_id || version.source_image_key !== head.source_image_key) {
        throw new CreatorError("Saved place history does not match its current scene", 409);
      }
    }
    const map = account(await db.collection<MapDoc>("world_map").findOne({ _id: sid }, options));
    const registry = account(await db.collection<RegistryDoc>("world_state").findOne({ _id: sid }, options));
    const worldMap = map ? (({ _id, ...rest }) => ({ ...rest, session_id: _id }))(map) : { session_id: sid, entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, schema_version: 1, updated_at: new Date(0) };
    const entities = registry ? { session_id: sid, updated_at: registry.updated_at, entities: registry.entities.filter(e => !e.deleted_at) } : { session_id: sid, entities: [], updated_at: new Date(0) };
    const meshIds = [...new Set(scenes.flatMap(s => s.definition.objects.flatMap(o => o.asset_id ? [o.asset_id] : [])))];
    const materialIds = [...new Set(scenes.flatMap(s => materialAssetIds(s.definition)))];
    const meshes = await rows<MeshAssetDoc>("mesh_assets", RECORD_CAP, { session_id: sid, ...(privateOwner ? {} : { id: { $in: meshIds } }) });
    const materials = await rows<MeshAssetDoc>("material_assets", RECORD_CAP, { session_id: sid, ...(privateOwner ? {} : { id: { $in: materialIds } }) });
    if (meshIds.some(id => !meshes.some(m => m.id === id)) || materialIds.some(id => !materials.some(m => m.id === id))) throw new CreatorError("World references a missing mesh or material asset", 409);
    const artwork = { heads: await rows<MapArtworkHead>("map_artwork_heads"), versions: await rows<MapArtworkVersion>("map_artwork_versions"), drafts: privateOwner ? await rows<MapAlignmentDraft>("map_alignment_drafts") : [] };
    const connections = account(await readConnectionGraph(db, sid, session));
    const views = privateOwner ? account(await snapshotPlaceViewExports(db, sid, session)) : [];
    const motion = { studies: privateOwner ? await rows<MotionStudyDoc>("motion_studies") : [],
      assets: privateOwner ? await rows<MotionAssetDoc>("motion_assets") : [],
      reviews: privateOwner ? await rows<MotionReviewDoc>("motion_reviews") : [],
      selections: [] as { _id: string; asset_id: string; review_id?: string }[] };
    for (const study of motion.studies) {
      if (!views.some(v => v.doc.id === study.view_id)) throw new CreatorError("Motion study references a missing camera view", 409);
      const selected = await db.collection<{ _id: string; asset_id: string; review_id?: string }>("motion_selections").findOne({ _id: `${sid}:${study.id}` }, options);
      if (selected) motion.selections.push(account({ _id: selected._id, asset_id: selected.asset_id, ...(selected.review_id ? { review_id: selected.review_id } : {}) }));
    }
    // Explicit whitelist: private notes, owner credentials, active jobs and
    // request receipts must never become portable world content.
    const workspace = privateOwner && metadata ? account({ title: metadata.title, archived: metadata.archived,
      resume_node_id: metadata.resume_node_id, resume_place_id: metadata.resume_place_id, resume_view: metadata.resume_view,
      walk_position: metadata.walk_position }) : null;
    return { session_id: sid, captured_at: new Date().toISOString(), privateOwner, nodes, scenes, sceneHeads: heads,
      worldMap, entities, registry: privateOwner ? registry : null, workspace, meshes, materials, artwork, connections, views, motion };
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
}
