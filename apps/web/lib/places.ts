import type { Document } from "mongodb";
import type { PlaceIdentityAnchor, PlaceUpdate, WorldEntityGeo } from "@openflipbook/config";
import { withDbTransaction, type NodeDoc } from "./db";
import { getStoredBytes } from "./r2";

export class PlaceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function updatePlace(sessionId: string, geoId: string, patch: PlaceUpdate): Promise<WorldEntityGeo> {
  return withDbTransaction(async (db, session) => {
    const maps = db.collection<Document & { _id: string; entities: WorldEntityGeo[]; updated_at: Date }>("world_map");
    const map = await maps.findOne({ _id: sessionId }, { session });
    const previous = map?.entities.find(e => e.id === geoId && e.kind === "place");
    if (!map || !previous) throw new PlaceError("Place not found", 404);
    if (previous.updated_at !== patch.expected_updated_at) throw new PlaceError("This place changed. Reload it before saving.", 409);
    let anchor: PlaceIdentityAnchor | null | undefined;
    if (patch.reference === null) anchor = null;
    else if (patch.reference) {
      const node = await db.collection<NodeDoc>("nodes").findOne({ _id: patch.reference.node_id, session_id: sessionId }, { session });
      if (!node) throw new PlaceError("Reference image is not in this world", 404);
      const imageKey = previous.identity_anchor?.node_id === node._id ? previous.identity_anchor.image_key : node.image_key;
      const stored = await getStoredBytes(imageKey);
      if (!stored || !stored.contentType.startsWith("image/") || stored.bytes.length > 20 * 1024 * 1024) throw new PlaceError("Reference image is unavailable or too large", 422);
      anchor = { node_id: node._id, image_key: imageKey, bbox: patch.reference.bbox };
    }
    const now = new Date(Math.max(Date.now(), map.updated_at.getTime() + 1, Date.parse(previous.updated_at) + 1));
    const next: WorldEntityGeo = {
      ...previous,
      ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
      ...(patch.visual !== undefined ? { visual: patch.visual.trim() } : {}),
      ...(patch.identity_locked !== undefined ? { identity_locked: patch.identity_locked } : {}),
      ...(anchor !== undefined ? { identity_anchor: anchor } : {}),
      updated_at: now.toISOString(),
    };
    await maps.updateOne({ _id: sessionId }, { $set: { entities: map.entities.map(e => e.id === geoId ? next : e), updated_at: now } }, { session });
    if (next.entity_id) {
      await db.collection<Document & { _id: string }>("world_state").updateOne(
        { _id: sessionId, "entities.id": next.entity_id },
        { $set: {
          "entities.$.name": next.label,
          "entities.$.appearance": next.visual,
          ...(patch.identity_locked !== undefined ? { "entities.$.pinned_by_user": patch.identity_locked } : {}),
          "entities.$.updated_at": now,
          updated_at: now,
        }, ...(next.label !== previous.label ? { $addToSet: { "entities.$.aliases": previous.label } } : {}) },
        { session },
      );
    }
    return next;
  });
}
