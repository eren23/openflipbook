import type { ClientSession, Db } from "mongodb";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
export interface SceneDoc extends PlaceSceneSnapshot { _id: string }
export async function writeSceneVersion(db: Db, session: ClientSession, scene: SceneDoc) {
  await db.collection<SceneDoc>("place_scenes").replaceOne({ _id: scene._id }, scene, { session, upsert: true });
  await db.collection<SceneDoc>("place_scene_versions").insertOne({ ...scene, _id: `${scene._id}:${scene.revision}` }, { session });
}
