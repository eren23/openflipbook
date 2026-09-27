import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import type { PlaceBuildConnectionInput } from "@openflipbook/config";
import { readConnectionGraph } from "./place-connection-graph";
import { CreatorError } from "./creator-error";

export const connectionInputHash = (input: PlaceBuildConnectionInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export async function readBuildConnections(db: Db, sid: string, pid: string, session?: ClientSession): Promise<PlaceBuildConnectionInput> {
  const all = await readConnectionGraph(db, sid, session);
  const connections = all.filter(c => c.a.place_id === pid || c.b.place_id === pid).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(c => ({ id: c.id, version: c.version, kind: c.kind, a: { place_id: c.a.place_id, side: c.a.side, offset: c.a.offset },
      b: { place_id: c.b.place_id, side: c.b.side, offset: c.b.offset }, width: c.width, created_at: c.created_at }));
  return { version: 1, place_id: pid, connections };
}

type BuildSource = { session_id: string; place_id: string; connection_input?: PlaceBuildConnectionInput; connections_sha256?: string };
export function buildConnectionsMatch(build: BuildSource, current: PlaceBuildConnectionInput) {
  // Old jobs have no frozen connection context. Keep unconnected ones usable,
  // but never invent dependencies for a connected legacy request after consent.
  if (!build.connection_input && !build.connections_sha256) return current.connections.length === 0;
  return !!build.connection_input && build.connection_input.place_id === build.place_id
    && connectionInputHash(build.connection_input) === build.connections_sha256 && connectionInputHash(current) === build.connections_sha256;
}

export async function buildConnectionsCurrent(db: Db, build: BuildSource, session?: ClientSession) {
  return buildConnectionsMatch(build, await readBuildConnections(db, build.session_id, build.place_id, session));
}

export async function requireBuildConnections(db: Db, build: Parameters<typeof buildConnectionsCurrent>[1], session?: ClientSession) {
  if (!await buildConnectionsCurrent(db, build, session)) throw new CreatorError("Place connections changed. Review a new layout request; this build was not rebased.", 409);
}
