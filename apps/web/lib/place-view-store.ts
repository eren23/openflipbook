import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Db } from "mongodb";
import type { WorldEntityGeo } from "@openflipbook/config";
import { CreatorError } from "./creator-error";
import type { SceneDoc } from "./place-scene-store";
import type { MeshAssetDoc } from "./mesh-docs";
import { readConnectionGraph } from "./place-connection-graph";
import { networkView, placeNetwork } from "./place-connections";
import { materialAssetIds } from "./surface-material";
import type { SavedPlaceView, ViewCapture, ViewPass, ViewSource } from "./place-view";

export interface PlaceViewDoc extends Omit<SavedPlaceView, "historical"> {
  _id: string; session_id: string; request_sha256: string;
  files: Record<ViewPass, { key: string; sha256: string; bytes: number }>;
  accepted_illustration_id?: string;
}
export const viewHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function currentSources(db: Db, sid: string, pid: string, mode: ViewCapture["mode"], session?: ClientSession): Promise<ViewSource[]> {
  const options = session ? { session } : {};
  const root = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}`, session_id: sid }, options);
  if (!root) throw new CreatorError("Save the place before capturing a view", 409);
  let chunks = [{ scene: root, x: 0, z: 0 }];
  if (mode === "walk") {
    const connections = await readConnectionGraph(db, sid, session);
    if (connections.some(c => c.a.place_id === pid || c.b.place_id === pid)) {
      const ids = [...new Set(connections.flatMap(c => [c.a.place_id, c.b.place_id]))];
      const scenes = await db.collection<SceneDoc>("place_scenes").find({ session_id: sid, place_id: { $in: ids } }, options).toArray();
      const map = await db.collection<{ _id: string; entities: WorldEntityGeo[] }>("world_map").findOne({ _id: sid }, options);
      let network;
      try { network = placeNetwork(pid, scenes, map?.entities ?? [], connections); }
      catch (e) { throw new CreatorError((e as Error).message, 409); }
      if (!network) throw new CreatorError("Connected view is unavailable", 409);
      chunks = networkView(network, pid).chunks.map(c => ({ ...c, scene: c.scene as SceneDoc }));
    }
  }
  return chunks.map(({ scene, x, z }) => ({ scene_id: scene.id, place_id: scene.place_id, revision: scene.revision, definition: scene.definition, x, z })).sort((a, b) => a.place_id.localeCompare(b.place_id));
}
export async function bindings(db: Db, sid: string, sources: ViewSource[], session?: ClientSession) {
  const assets: SavedPlaceView["assets"] = [], options = session ? { session } : {};
  for (const kind of ["mesh", "material"] as const) {
    const ids = [...new Set(sources.flatMap(s => kind === "mesh" ? s.definition.objects.flatMap(o => o.asset_id ? [o.asset_id] : []) : materialAssetIds(s.definition)))].sort();
    for (const id of ids) {
      const asset = await db.collection<MeshAssetDoc>(`${kind}_assets`).findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
      if (!asset) throw new CreatorError("A view source asset is missing", 409);
      assets.push({ kind, id, sha256: asset.sha256 });
    }
  }
  return { sources: sources.map(({ definition, ...s }) => ({ ...s, definition_sha256: viewHash(definition) })), assets };
}
export async function assertCurrentView(db: Db, view: PlaceViewDoc, session?: ClientSession) {
  const sources = await currentSources(db, view.session_id, view.root_place_id, view.mode, session);
  if (!isDeepStrictEqual(await bindings(db, view.session_id, sources, session), { sources: view.sources, assets: view.assets })) throw new CreatorError("View sources changed. Capture the saved scene again.", 409);
  return sources;
}
export async function fenceViewSources(db: Db, view: PlaceViewDoc, session: ClientSession) {
  for (const source of view.sources) {
    const result = await db.collection<SceneDoc>("place_scenes").updateOne({ _id: `${view.session_id}:${source.place_id}`, revision: source.revision }, { $inc: { view_capture_fence: 1 } }, { session });
    if (!result.matchedCount) throw new CreatorError("View geometry changed", 409);
  }
  if (view.sources.length > 1) await db.collection<{ _id: string; view_capture_fence?: number }>("world_map").updateOne({ _id: view.session_id }, { $inc: { view_capture_fence: 1 } }, { session });
}
