import type { ClientSession, Db } from "mongodb";
import type { PlaceConnection, PlaceNetwork, PlaceSceneSnapshot, WorldEntityGeo } from "@openflipbook/config";
import type { SceneDoc } from "./place-scene-store";
import { CreatorError, requireCreator } from "./creator";
import { withDbTransaction } from "./db";
import { placeNetwork } from "./place-connections";

import { readConnectionGraph } from "./place-connection-graph";
export { readConnectionGraph, wireConnection, type ConnectionDoc } from "./place-connection-graph";

export async function checkConnectedSceneEdit(db: Db, sid: string, scene: PlaceSceneSnapshot, geos: WorldEntityGeo[], session?: ClientSession, added?: PlaceConnection) {
  const all = await readConnectionGraph(db,sid,session);
  if(added&&all.length>=256)throw new CreatorError("World exceeds 256 connections",409);
  const links = added?[...all,added]:all;
  if(!links.some(c=>c.a.place_id===scene.place_id||c.b.place_id===scene.place_id)) return;
  const ids = [...new Set(links.flatMap(c=>[c.a.place_id,c.b.place_id]))];
  const scenes = await db.collection<SceneDoc>("place_scenes").find({session_id:sid,place_id:{$in:ids}},session?{session}:{}).toArray();
  try {placeNetwork(scene.place_id,[...scenes.filter(s=>s.place_id!==scene.place_id),scene],geos,links);}
  catch(e){throw new CreatorError((e as Error).message,409);}
}

export async function readPlaceNetwork(sid: string, pid: string): Promise<PlaceNetwork | null> {
  await requireCreator(sid);
  return withDbTransaction(async (db,session)=>{
    const connections=await readConnectionGraph(db,sid,session);
    if(!connections.some(c=>c.a.place_id===pid||c.b.place_id===pid))return null;
    const ids=[...new Set(connections.flatMap(c=>[c.a.place_id,c.b.place_id]))];
    const scenes=await db.collection<SceneDoc>("place_scenes").find({session_id:sid,place_id:{$in:ids}},{session}).toArray();
    const map=await db.collection<{_id:string;entities:WorldEntityGeo[]}>("world_map").findOne({_id:sid},{session});
    try {return placeNetwork(pid,scenes.map(({_id:_unused,...s})=>s),map?.entities??[],connections);}
    catch(e){throw new CreatorError((e as Error).message,409);}
  });
}
