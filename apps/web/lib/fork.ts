import type { Document } from "mongodb";

import { getDb, type NodeDoc } from "./db";

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
//   SKIPPED   session_owners     (the forker claims the fork on first write)
//             published_sessions (forks start unpublished)
//             session_presence   (ephemeral)
//             idempotency_keys / spend_ledger / errors (per-session ledgers)

export interface ForkResult {
  session_id: string;
  nodes: number;
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

export async function forkSession(
  sourceSessionId: string,
  // The node the fork was taken FROM (the /n/ page's node) — stamped as
  // lineage on the fork's root(s).
  sourceNodeId: string | null
): Promise<ForkResult | null> {
  const db = await getDb();
  const nodesCol = db.collection<NodeDoc>("nodes");
  const sourceNodes = await nodesCol
    .find({ session_id: sourceSessionId })
    .sort({ created_at: 1, _id: 1 })
    .toArray();
  if (sourceNodes.length === 0) return null;

  const newSessionId = `session_${crypto.randomUUID()}`;
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
  await nodesCol.insertMany(forkedNodes);

  // world_map: keyed by _id = session id. Geo ids (geo_*/geo_plan_*) are
  // session-local strings — copy verbatim.
  const worldMap = await db
    .collection<Document & { _id: string }>("world_map")
    .findOne({ _id: sourceSessionId });
  if (worldMap) {
    await db
      .collection<Document & { _id: string }>("world_map")
      .insertOne({ ...worldMap, _id: newSessionId });
  }

  // world_state: keyed by _id = session id; entities reference node ids in
  // five places — remap them all (an unmapped id is kept as-is: it was
  // already dangling in the source, the fork must not invent or drop data).
  interface WorldStateEntity extends Document {
    first_seen_node_id: string;
    last_seen_node_id: string;
    appears_on_node_ids: string[];
    appearance_bboxes?: Record<string, unknown>;
    appearance_borders?: Record<string, unknown>;
  }
  const worldState = await db
    .collection<Document & { _id: string; entities?: WorldStateEntity[] }>(
      "world_state"
    )
    .findOne({ _id: sourceSessionId });
  if (worldState) {
    const entities = (worldState.entities ?? []).map((e) => ({
      ...e,
      first_seen_node_id: idMap.get(e.first_seen_node_id) ?? e.first_seen_node_id,
      last_seen_node_id: idMap.get(e.last_seen_node_id) ?? e.last_seen_node_id,
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
      .insertOne({ ...worldState, _id: newSessionId, entities });
  }

  return { session_id: newSessionId, nodes: forkedNodes.length };
}
