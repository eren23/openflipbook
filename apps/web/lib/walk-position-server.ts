import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import type { SceneDoc } from "./place-scene-store";
import { parseWalkWrite, poseInsidePlace, poseSpaceMatches, type SavedWalkPosition, type WalkPositionWrite } from "./walk-position";

interface WalkMetadata {
  _id: string;
  walk_position?: SavedWalkPosition;
  walk_request?: WalkPositionWrite;
}
export async function readWalkPosition(sid: string): Promise<SavedWalkPosition> {
  const db = await requireCreator(sid);
  return (await db.collection<WalkMetadata>("creator_worlds").findOne({_id:sid}))?.walk_position ?? {revision:0,pose:null};
}

export async function saveWalkPosition(sid: string, value: unknown): Promise<SavedWalkPosition> {
  await requireCreator(sid);
  const input = parseWalkWrite(value);
  if (!input) throw new CreatorError("Invalid walking position",400);
  return withDbTransaction(async (db,session) => {
    const col = db.collection<WalkMetadata>("creator_worlds"), options = {session};
    const metadata = await col.findOne({_id:sid},options);
    if (metadata?.walk_request?.request_id === input.request_id) {
      if (JSON.stringify(metadata.walk_request) !== JSON.stringify(input)) throw new CreatorError("Position request was reused with different content",409);
      return metadata.walk_position!;
    }
    const current = metadata?.walk_position?.revision ?? 0;
    if (current !== input.base_revision) throw new CreatorError("Walking position changed in another tab. Reload the saved position.",409);
    const scene = await db.collection<SceneDoc>("place_scenes").findOne({session_id:sid,place_id:input.pose.place_id},options);
    if (!scene) throw new CreatorError("Saved place not found",404);
    if (scene.revision !== input.pose.scene_revision) throw new CreatorError("Place geometry changed. Reload before saving a position.",409);
    if (!poseInsidePlace(input.pose,scene.definition)) throw new CreatorError("Position is outside the saved place",400);
    if (!poseSpaceMatches(input.pose,scene.definition)) throw new CreatorError("Position does not match its building and floor",400);
    const saved = {revision:current+1,pose:input.pose};
    await col.updateOne({_id:sid},{$set:{walk_position:saved,walk_request:input,
      resume_place_id:input.pose.place_id,resume_node_id:null,resume_view:"walk",last_opened_at:new Date()}},{...options,upsert:true});
    return saved;
  });
}
