import type { ClientSession, Db } from "mongodb";
import type { NodeDoc } from "./db";
import { getDb } from "./db";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { placeScenesEnabled } from "./place-scene-enabled";
import type { SceneDoc } from "./place-scene-store";
import { parseMapRegistration, type MapRepaintBinding } from "./map-artwork";
import { parseAlignmentFrame, parseMapLandmarks, type MapAlignmentDraft } from "./map-alignment";
import { isDeepStrictEqual } from "node:util";
import { getStoredBytes } from "./r2";
import sharp from "sharp";
import { correctMapLandmarks, type MapAlignmentCorrection } from "./map-alignment-correction";

export interface MapArtworkHead { _id: string; node_id: string; session_id: string; map_root_node_id: string }
export interface MapArtworkVersion extends MapRepaintBinding { _id: string; session_id: string; node_id: string; created_at: Date }
export const artworkHeadKey = (sid: string, root: string) => `${sid}:${root}`;
export async function mapArtworkContext(sid: string, pid: string) {
  if (!placeScenesEnabled() || !isSafeId(sid) || !isSafeId(pid)) throw new CreatorError("Invalid place", 400);
  const db = await requireCreator(sid);
  const scene = await db.collection<SceneDoc>("place_scenes").findOne({ session_id: sid, place_id: pid });
  if (!scene) throw new CreatorError("Save the place before repainting its map", 409);
  if (!scene.source_node_id) throw new CreatorError("This place has no saved reference artwork", 409);
  const reference = await db.collection<NodeDoc>("nodes").findOne({ _id: scene.source_node_id, session_id: sid });
  if (!reference) throw new CreatorError("Place reference artwork is missing", 409);
  // A root place has its own reference, not a fictitious parent map. Neither
  // source acquires a registration until an artwork proposal is accepted.
  const root = reference.parent_id ? await db.collection<NodeDoc>("nodes").findOne({ _id: reference.parent_id, session_id: sid }) : reference;
  if (!root) throw new CreatorError("This place has no saved parent map", 409);
  const head = await db.collection<MapArtworkHead>("map_artwork_heads").findOne({ _id: artworkHeadKey(sid, root._id) });
  const source = head ? await db.collection<NodeDoc>("nodes").findOne({ _id: head.node_id, session_id: sid }) : root;
  if (!source) throw new CreatorError("Current map artwork is missing", 409);
  const previous = await db.collection<MapArtworkVersion>("map_artwork_versions").find({ session_id: sid, map_root_node_id: root._id, scene_id: scene.id }).sort({ created_at: -1 }).limit(1).toArray();
  const baseline = await db.collection<SceneDoc>("place_scene_versions").findOne({ session_id: sid, place_id: pid, revision: previous[0]?.scene_revision ?? 1 });
  if (!baseline) throw new CreatorError("Map baseline revision is unavailable", 409);
  const alignment = await db.collection<MapAlignmentDraft>("map_alignment_drafts").findOne({_id:`${sid}:${pid}`,session_id:sid});
  return { scene, baseline, map: { id: source._id, root_id: root._id, title: root.page_title, url: `/api/image/${encodeURIComponent(source._id)}`, reference_kind: reference.parent_id ? "parent_map" as const : "place_reference" as const }, registration: previous[0]?.registration ?? null,
    alignment, alignment_stale:!!alignment && (alignment.scene_revision!==scene.revision || alignment.scene_id!==scene.id || alignment.map_node_id!==source._id) };
}
export async function saveMapAlignment(sid:string,pid:string,input:Record<string,unknown>) {
  const context=await mapArtworkContext(sid,pid),db=await requireCreator(sid);
  if(input.scene_revision!==context.scene.revision || input.map_node_id!==context.map.id)throw new CreatorError("Artwork or geometry changed. Reload alignment.",409);
  if(!Number.isSafeInteger(input.revision)||Number(input.revision)<0)throw new CreatorError("Invalid alignment revision",400);
  let frame,landmarks,registration;
  try{frame=parseAlignmentFrame(input.frame);landmarks=parseMapLandmarks(input.landmarks,context.scene.definition);registration=parseMapRegistration(input.registration);}catch(e){throw new CreatorError((e as Error).message,400);}
  const source=await db.collection<NodeDoc>("nodes").findOne({_id:context.map.id,session_id:sid});
  if(!source?.image_key)throw new CreatorError("Artwork image is unavailable",409);
  const stored=await getStoredBytes(source.image_key);if(!stored)throw new CreatorError("Artwork image is unavailable",409);
  const info=await sharp(stored.bytes,{limitInputPixels:8192*8192}).metadata();
  if(info.width!==frame.width||info.height!==frame.height)throw new CreatorError("Artwork dimensions changed. Reload alignment.",409);
  const col=db.collection<MapAlignmentDraft>("map_alignment_drafts"),key=`${sid}:${pid}`;
  const content={session_id:sid,place_id:pid,scene_id:context.scene.id,scene_revision:context.scene.revision,scene_source_node_id:context.scene.source_node_id!,map_node_id:context.map.id,frame,landmarks,registration};
  const old=await col.findOne({_id:key});
  if(old?.revision===Number(input.revision)+1 && Object.entries(content).every(([k,v])=>isDeepStrictEqual(old[k as keyof MapAlignmentDraft],v)))return {alignment:old};
  const doc:MapAlignmentDraft={_id:key,...content,revision:Number(input.revision)+1,updated_at:new Date()};
  if(input.revision===0){try{await col.insertOne(doc);}catch(e){if((e as {code?:number}).code===11000)throw new CreatorError("Alignment changed in another tab. Reload before saving.",409);throw e;}}
  else if(!(await col.replaceOne({_id:key,revision:Number(input.revision)},doc)).matchedCount)throw new CreatorError("Alignment changed in another tab. Reload before saving.",409);
  return {alignment:doc};
}
export async function prepareMapAlignmentCorrection(sid: string, pid: string, input: unknown) {
  const request = input as { revision?: unknown; object_ids?: unknown; confirmed_projection?: unknown };
  if (!request || request.confirmed_projection !== true) throw new CreatorError("Review the approximate ground-plane projection first", 400);
  const context = await mapArtworkContext(sid, pid), draft = context.alignment;
  if (!draft || context.alignment_stale || draft.revision !== request.revision) throw new CreatorError("Alignment changed. Reload and save a current draft.", 409);
  let definition;
  try { definition = correctMapLandmarks(context.scene.definition, draft, request.object_ids); }
  catch (e) { throw new CreatorError((e as Error).message, 400); }
  const source: MapAlignmentCorrection = { projection: "manual_planar", draft, map_root_node_id: context.map.root_id, object_ids: request.object_ids as string[] };
  return { definition, source };
}
export async function assertMapAlignmentCorrectionCurrent(db: Db, session: ClientSession, sid: string, pid: string, source: MapAlignmentCorrection) {
  const draft = await db.collection<MapAlignmentDraft>("map_alignment_drafts").findOne({ _id: `${sid}:${pid}`, session_id: sid }, { session });
  const head = await db.collection<MapArtworkHead>("map_artwork_heads").findOne({ _id: artworkHeadKey(sid, source.map_root_node_id) }, { session });
  if (!draft || draft.revision !== source.draft.revision || !isDeepStrictEqual(draft.landmarks, source.draft.landmarks) || !isDeepStrictEqual(draft.registration, source.draft.registration) || (head?.node_id ?? source.map_root_node_id) !== source.draft.map_node_id) throw new CreatorError("Alignment or artwork changed after preview. Review a fresh correction.", 409);
  // Serialize against concurrent draft replacement, without accepting registration.
  await db.collection<MapAlignmentDraft & { correction_fence?: number }>("map_alignment_drafts").updateOne({ _id: draft._id, revision: draft.revision }, { $inc: { correction_fence: 1 } }, { session });
}
export async function assertMapRepaintCurrent(sid: string, binding: MapRepaintBinding, db?: Db, session?: ClientSession) {
  const database = db ?? await getDb(), options = session ? { session } : {};
  const scene = await database.collection<SceneDoc>("place_scenes").findOne({ session_id: sid, id: binding.scene_id, place_id: binding.place_id }, options);
  if (!scene || scene.revision !== binding.scene_revision) throw new CreatorError("Geometry changed. Prepare a fresh map repaint from the saved revision.", 409);
  const head = await database.collection<MapArtworkHead>("map_artwork_heads").findOne({ _id: artworkHeadKey(sid, binding.map_root_node_id) }, options);
  if ((head?.node_id ?? binding.map_root_node_id) !== binding.base_map_node_id) throw new CreatorError("Map artwork changed. Prepare a repaint from its latest version.", 409);
  return scene;
}
