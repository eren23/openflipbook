import type { ClientSession, Db, Document } from "mongodb";
import { createHash } from "node:crypto";
import type { WorldEntityGeo } from "@openflipbook/config";

import { getDb, withDbTransaction, type NodeDoc } from "./db";
import { remapTransition } from "./transition-context";
import type { SceneDoc } from "./place-scene-server";
import type { MeshAssetDoc } from "./mesh-server";
import type { MeshSourceDoc } from "./mesh-source";
import type { MapArtworkHead, MapArtworkVersion } from "./map-artwork-server";
import { CreatorError } from "./creator-error";
import type { PlaceViewDoc } from "./place-view-server";
import { getExistingOwnerToken } from "./session-owner";
import { isSafeId } from "./ids";
import type { ConnectionDoc } from "./place-connections-store";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionReviewDoc } from "./motion-job";
import { viewHash } from "./place-view-store";
import type { MapAlignmentDraft } from "./map-alignment";

// Fork a session: deep-copy its world into a fresh session_id so anyone with
// a share link gets their OWN world to extend instead of write access to the
// original (the ?continue= hazard). Images are referenced by the existing R2
// image_key — a fork costs $0 in model calls and no object copies.
//
// The session-scoped collection inventory — the loud list, so a future
// collection can't silently miss the copy (the corruption class the fork
// review flagged):
//   COPIED    nodes        (node ids REMINTED — they are globally unique;
//                           parent_id + scene_view.node_id remapped)
//             world_state  (_id = session; entity node-refs remapped in all
//                           five places: first/last_seen, appears_on,
//                           appearance_bboxes keys, appearance_borders keys)
//             world_map    (_id = session — the Ankh gotcha; geo ids are
//                           session-local, no remap needed)
//             place_scenes / place_scene_versions (source node remapped)
//             map_artwork_heads / map_artwork_versions (all node refs remapped)
//   OWNER     camera views, illustrations, motion studies/assets/reviews/selections
//             map alignment drafts (unaccepted annotation evidence)
//   SKIPPED   generation jobs, provider leases and spend reservations
//   CREATED   session_owners / fork_receipts (atomic ownership and retry identity)
//   SKIPPED   original owner tokens and original fork receipts
//             published_sessions (forks start unpublished)
//             session_presence   (ephemeral)
//             idempotency_keys / spend_ledger / errors (per-session ledgers)

export interface ForkResult {
  session_id: string;
  nodes: number;
  place_id?: string;
}
interface ForkReceipt { _id: string; source_session_id: string; source_node_id: string | null; result: ForkResult; created_at: Date }

export async function forkSession(sourceSessionId: string, sourceNodeId: string | null, requestId = crypto.randomUUID()): Promise<ForkResult | null> {
  if (!isSafeId(sourceSessionId) || sourceNodeId !== null && !isSafeId(sourceNodeId) || !isSafeId(requestId)) throw new CreatorError("Invalid fork identity", 400);
  const token = await getExistingOwnerToken();
  if (!token) throw new CreatorError("Initialize this browser's workspace before forking", 409);
  const key = createHash("sha256").update(JSON.stringify([token, requestId])).digest("hex"), newSessionId = `session_${key}`;
  const replay = async (db: Db, session?: ClientSession) => {
    const options = session ? { session } : {};
    const receipt = await db.collection<ForkReceipt>("fork_receipts").findOne({ _id: key }, options);
    if (!receipt) return null;
    if (receipt.source_session_id !== sourceSessionId || receipt.source_node_id !== sourceNodeId) throw new CreatorError("Fork request already used for another source", 409);
    const owner = await db.collection<{ _id: string; owner_token: string }>("session_owners").findOne({ _id: receipt.result.session_id }, options);
    if (owner?.owner_token !== token) throw new CreatorError("Fork ownership is unavailable", 403);
    return receipt.result;
  };
  try {
    return await withDbTransaction(async (db, session) => {
      const old = await replay(db, session); if (old) return old;
      const options = { session }, owners = db.collection<{ _id: string; owner_token: string; created_at: Date }>("session_owners");
      if (await owners.findOne({ _id: newSessionId }, options)) throw new CreatorError("Fork identity already exists", 409);
      const sourceOwner = await owners.findOne({ _id: sourceSessionId }, options);
      const result = await copySession(db, session, sourceSessionId, sourceNodeId, newSessionId, sourceOwner?.owner_token === token);
      if (!result) return null;
      await owners.insertOne({ _id: newSessionId, owner_token: token, created_at: new Date() }, options);
      await db.collection<ForkReceipt>("fork_receipts").insertOne({ _id: key, source_session_id: sourceSessionId, source_node_id: sourceNodeId, result, created_at: new Date() }, options);
      return result;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (e) {
    // A concurrent identical request can win the unique insert. Only its
    // committed receipt authorizes replay; never retry a partial copy manually.
    if ((e as { code?: number }).code === 11000) { const result = await replay(await getDb()); if (result) return result; }
    throw e;
  }
}

function remapKeys<T>(
  map: Record<string, T> | undefined,
  idMap: Map<string, string>
): Record<string, T> | undefined {
  if (!map) return map;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[idMap.get(k) ?? k] = v;
  return out;
}

async function copySession(
  db: Db, session: ClientSession,
  sourceSessionId: string,
  // The node the fork was taken FROM (the /n/ page's node) — stamped as
  // lineage on the fork's root(s).
  sourceNodeId: string | null,
  newSessionId: string,
  ownsSource: boolean,
): Promise<ForkResult | null> {
  const options = { session };
  const sourceMetadata = await db.collection<{ _id: string; visibility?: string; title?: string }>("creator_worlds").findOne({ _id: sourceSessionId }, options);
  if (sourceMetadata?.visibility === "private" && !ownsSource) throw new CreatorError("This world is not owned by this browser", 403);
  const nodesCol = db.collection<NodeDoc>("nodes");
  const sourceNodes = await nodesCol
    .find({ session_id: sourceSessionId }, options)
    .sort({ created_at: 1, _id: 1 })
    .toArray();
  const sourceScenes = await db.collection<SceneDoc>("place_scenes").find({ session_id: sourceSessionId }, options).toArray();
  if (sourceNodes.length === 0 && sourceScenes.length === 0) return null;
  // Source-free worlds have no public image link. They remain owner-only.
  if (sourceNodes.length === 0 && !ownsSource) throw new CreatorError("This world is not owned by this browser", 403);
  if (sourceNodeId && !sourceNodes.some(n => n._id === sourceNodeId)) throw new CreatorError("Fork source node is outside this world", 400);
  const viewCol = db.collection<PlaceViewDoc>("place_views");
  // Walk checkpoints serve only walk videos, which a fork does not copy.
  const privateViews = ownsSource ? (await viewCol.find({ session_id: sourceSessionId }, options).toArray()).filter(view => !view.walk_checkpoint) : [];
  const privateIllustrations = privateViews.length ? await db.collection<MeshAssetDoc>("illustration_assets").find({ session_id: sourceSessionId, "view_dependency.view_id": { $in: privateViews.map(v => v.id) } }, options).toArray() : [];
  const meshAssets = db.collection<MeshAssetDoc>("mesh_assets");
  const savedMeshes = await meshAssets.find({ session_id: sourceSessionId }, options).toArray();
  const sourceCol = db.collection<MeshSourceDoc>("mesh_sources");
  const privateSources = ownsSource ? await sourceCol.find({ session_id: sourceSessionId }, options).toArray() : [];
  if (sourceMetadata?.visibility === "private" || sourceNodes.length === 0) await db.collection<Document & { _id: string }>("creator_worlds").insertOne({
    _id: newSessionId, visibility: "private", title: sourceMetadata?.title ?? sourceScenes[0]?.definition.label,
    resume_place_id: sourceScenes[0]?.place_id ?? null, last_opened_at: new Date(),
  }, options);
  const idMap = new Map<string, string>(
    sourceNodes.map((n) => [n._id, crypto.randomUUID()])
  );

  const forkedNodes: NodeDoc[] = sourceNodes.map((n) => {
    const sceneView = n.scene_view
      ? {
          ...n.scene_view,
          ...(n.scene_view.node_id
            ? { node_id: idMap.get(n.scene_view.node_id) ?? n.scene_view.node_id }
            : {}),
        }
      : (n.scene_view ?? null);
    return {
      ...n,
      _id: idMap.get(n._id)!,
      session_id: newSessionId,
      parent_id: n.parent_id ? (idMap.get(n.parent_id) ?? null) : null,
      scene_view: sceneView,
      transition_context: remapTransition(n.transition_context, idMap),
      // Lineage rides the fork's root(s); created_at is preserved so the
      // world's history (hydration order, atlas) stays the world's history.
      ...(n.parent_id == null
        ? {
            forked_from: {
              session_id: sourceSessionId,
              node_id: sourceNodeId,
            },
          }
        : {}),
    };
  });
  if (forkedNodes.length) await nodesCol.insertMany(forkedNodes, options);

  // world_map: keyed by _id = session id. Geo ids (geo_*/geo_plan_*) are
  // session-local strings — copy verbatim.
  const worldMap = await db
    .collection<Document & { _id: string }>("world_map")
    .findOne({ _id: sourceSessionId }, options);
  if (worldMap) {
    await db
      .collection<Document & { _id: string }>("world_map")
      .insertOne({ ...worldMap, _id: newSessionId, entities: (worldMap.entities as WorldEntityGeo[] ?? []).map(e => ({
        ...e,
        ...(e.identity_anchor ? { identity_anchor: { ...e.identity_anchor, node_id: idMap.get(e.identity_anchor.node_id) ?? e.identity_anchor.node_id } } : {}),
      })) }, options);
  }

  // world_state: keyed by _id = session id; entities reference node ids in
  // five places — remap them all (an unmapped id is kept as-is: it was
  // already dangling in the source, the fork must not invent or drop data).
  interface WorldStateEntity extends Document {
    first_seen_node_id: string | null;
    last_seen_node_id: string | null;
    appears_on_node_ids: string[];
    appearance_bboxes?: Record<string, unknown>;
    appearance_borders?: Record<string, unknown>;
  }
  const worldState = await db
    .collection<Document & { _id: string; entities?: WorldStateEntity[] }>(
      "world_state"
    )
    .findOne({ _id: sourceSessionId }, options);
  if (worldState) {
    const entities = (worldState.entities ?? []).map((e) => ({
      ...e,
      first_seen_node_id: e.first_seen_node_id ? idMap.get(e.first_seen_node_id) ?? e.first_seen_node_id : null,
      last_seen_node_id: e.last_seen_node_id ? idMap.get(e.last_seen_node_id) ?? e.last_seen_node_id : null,
      appears_on_node_ids: (e.appears_on_node_ids ?? []).map(
        (id) => idMap.get(id) ?? id
      ),
      ...(e.appearance_bboxes
        ? { appearance_bboxes: remapKeys(e.appearance_bboxes, idMap) }
        : {}),
      ...(e.appearance_borders
        ? { appearance_borders: remapKeys(e.appearance_borders, idMap) }
        : {}),
    }));
    await db
      .collection<Document & { _id: string }>("world_state")
      .insertOne({ ...worldState, _id: newSessionId, entities }, options);
  }

  // Scene/geo ids are session-local; source node ids are not. Proposal receipts
  // are intentionally not copied: a fork cannot replay an original's write.
  for (const name of ["place_scenes", "place_scene_versions"]) {
    const col = db.collection<SceneDoc>(name);
    const scenes = await col.find({ session_id: sourceSessionId }, options).toArray();
    if (scenes.length) await col.insertMany(scenes.map(scene => ({
      ...scene, _id: `${newSessionId}:${scene.place_id}${name === "place_scene_versions" ? `:${scene.revision}` : ""}`,
      session_id: newSessionId, source_node_id: scene.source_node_id ? idMap.get(scene.source_node_id) ?? scene.source_node_id : null,
    })), options);
  }
  const artwork = db.collection<MapArtworkVersion>("map_artwork_versions");
  const connectionCol=db.collection<ConnectionDoc>("place_connections");
  const connections=await connectionCol.find({session_id:sourceSessionId},options).toArray();
  if(connections.length)await connectionCol.insertMany(connections.map(c=>({...c,_id:`${newSessionId}:${c.id}`,session_id:newSessionId})),options);
  // Reference origin IDs describe the original input, not fork geometry. Keys
  // stay immutable; only the owner receives private concept bytes/provenance.
  if (privateSources.length) await sourceCol.insertMany(privateSources.map(source => ({ ...source, _id: `${newSessionId}:${source.id}`, session_id: newSessionId })), options);
  if (savedMeshes.length) await meshAssets.insertMany(savedMeshes.map(({ image_input, ...asset }) => ({ ...asset, _id: `${newSessionId}:${asset.id}`, session_id: newSessionId,
    ...(image_input && ownsSource ? { image_input: { ...image_input, _id: `${newSessionId}:${image_input.id}`, session_id: newSessionId } } : {}) })), options);
  const materialAssets = db.collection<MeshAssetDoc>("material_assets");
  const savedMaterials = await materialAssets.find({ session_id: sourceSessionId }, options).toArray();
  if (savedMaterials.length) await materialAssets.insertMany(savedMaterials.map(asset => ({ ...asset, _id: `${newSessionId}:${asset.id}`, session_id: newSessionId })), options);
  // Private captures are copied only for their owner; immutable source IDs,
  // geometry hashes and storage references survive without rendering again.
  if (privateViews.length) await viewCol.insertMany(privateViews.map(view => ({ ...view, _id: `${newSessionId}:${view.id}`, session_id: newSessionId })), options);
  if (privateIllustrations.length) await db.collection<MeshAssetDoc>("illustration_assets").insertMany(privateIllustrations.map(asset => ({ ...asset, _id: `${newSessionId}:${asset.id}`, session_id: newSessionId })), options);
  if (ownsSource) {
    const studyCol = db.collection<MotionStudyDoc>("motion_studies");
    const studies = await studyCol.find({ session_id: sourceSessionId }, options).toArray();
    const viewIds = new Set(privateViews.map(view => view.id));
    if (studies.some(study => !viewIds.has(study.view_id))) throw new CreatorError("Motion study camera is missing; fork was not created", 409);
    const copiedStudies = studies.map(study => ({ ...study, _id: `${newSessionId}:${study.id}`, session_id: newSessionId,
      forked_from: { session_id: sourceSessionId, study_id: study.id, study_sha256: viewHash(study) } }));
    const sourceStudyHashes = new Map(studies.map(study => [study.id, viewHash(study)]));
    const copiedStudyHashes = new Map(copiedStudies.map(study => [study.id, viewHash(study)]));
    if (copiedStudies.length) await studyCol.insertMany(copiedStudies, options);
    const assetsCol = db.collection<MotionAssetDoc>("motion_assets");
    const assets = await assetsCol.find({ session_id: sourceSessionId }, options).toArray();
    if (assets.some(asset => !copiedStudyHashes.has(asset.study_id) || asset.study_sha256 !== sourceStudyHashes.get(asset.study_id)))
      throw new CreatorError("Motion clip study binding is invalid; fork was not created", 409);
    // The session-scoped study hash changes, but file hashes, geometry and the
    // provider receipt do not. Preserve the original binding as provenance.
    if (assets.length) await assetsCol.insertMany(assets.map(asset => ({ ...asset, _id: `${newSessionId}:${asset.id}`, session_id: newSessionId,
      study_sha256: copiedStudyHashes.get(asset.study_id)!,
      forked_from: { session_id: sourceSessionId, asset_id: asset.id, study_sha256: asset.study_sha256 } })), options);
    const assetById = new Map(assets.map(asset => [asset.id, asset]));
    const reviewCol = db.collection<MotionReviewDoc>("motion_reviews");
    const reviews = await reviewCol.find({ session_id: sourceSessionId }, options).toArray();
    if (reviews.some(review => { const asset = assetById.get(review.asset_id); return !asset || asset.study_id !== review.study_id
      || asset.silent.sha256 !== review.video_sha256 || asset.comparison?.sha256 !== review.comparison_sha256; }))
      throw new CreatorError("Motion review binding is invalid; fork was not created", 409);
    if (reviews.length) await reviewCol.insertMany(reviews.map(review => ({ ...review, _id: `${newSessionId}:${review.id}`, session_id: newSessionId })), options);
    const selections = db.collection<{ _id: string; asset_id: string; review_id?: string }>("motion_selections");
    for (const study of studies) {
      const selection = await selections.findOne({ _id: `${sourceSessionId}:${study.id}` }, options);
      if (!selection) continue;
      if (assetById.get(selection.asset_id)?.study_id !== study.id || selection.review_id
        && !reviews.some(review => review.id === selection.review_id && review.asset_id === selection.asset_id))
        throw new CreatorError("Motion selection binding is invalid; fork was not created", 409);
      await selections.insertOne({ ...selection, _id: `${newSessionId}:${study.id}` }, options);
    }
  }
  const versions = await artwork.find({ session_id: sourceSessionId }, options).toArray();
  const remap = (id: string) => idMap.get(id) ?? id;
  if(ownsSource){
    const drafts=db.collection<MapAlignmentDraft>("map_alignment_drafts"),saved=await drafts.find({session_id:sourceSessionId},options).toArray();
    if(saved.some(d=>!idMap.has(d.map_node_id)||!idMap.has(d.scene_source_node_id)))throw new CreatorError("Alignment draft source is missing",409);
    if(saved.length)await drafts.insertMany(saved.map(d=>({...d,_id:`${newSessionId}:${d.place_id}`,session_id:newSessionId,map_node_id:remap(d.map_node_id),scene_source_node_id:remap(d.scene_source_node_id)})),options);
  }
  if (versions.length) await artwork.insertMany(versions.map(v => ({ ...v,
    _id: remap(v.node_id), node_id: remap(v.node_id), session_id: newSessionId,
    scene_source_node_id: remap(v.scene_source_node_id), map_root_node_id: remap(v.map_root_node_id), base_map_node_id: remap(v.base_map_node_id),
  })), options);
  const heads = db.collection<MapArtworkHead>("map_artwork_heads");
  const current = await heads.find({ session_id: sourceSessionId }, options).toArray();
  if (current.length) await heads.insertMany(current.map(h => ({ ...h,
    _id: `${newSessionId}:${remap(h.map_root_node_id)}`, session_id: newSessionId,
    node_id: remap(h.node_id), map_root_node_id: remap(h.map_root_node_id),
  })), options);
  return { session_id: newSessionId, nodes: forkedNodes.length, ...(!forkedNodes.length && sourceScenes[0] ? { place_id: sourceScenes[0].place_id } : {}) };
}
