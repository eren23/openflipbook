import type { ClientSession, Db } from "mongodb";
import type { PlaceConnection } from "@openflipbook/config";
import { CreatorError } from "./creator-error";

export interface ConnectionDoc extends PlaceConnection { _id: string; session_id: string }
export const wireConnection = ({ _id: _key, session_id: _sid, ...connection }: ConnectionDoc): PlaceConnection => connection;
export async function readConnectionGraph(db: Db, sid: string, session?: ClientSession) {
  const docs = await db.collection<ConnectionDoc>("place_connections").find({ session_id: sid }, session ? { session } : {}).limit(257).toArray();
  if (docs.length > 256) throw new CreatorError("World exceeds 256 connections", 409);
  return docs.map(wireConnection);
}
