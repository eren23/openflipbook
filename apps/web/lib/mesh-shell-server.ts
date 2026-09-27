import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import type { MeshAssetDoc } from "./mesh-execution";
import { CreatorError } from "./creator";
import { getStoredBytes } from "./r2";
import { inspectMeshImport } from "./mesh-import";
import { withMeshGeometry } from "./mesh-geometry";
import { fitGeneratedMesh } from "./mesh-transform";
import { inspectMeshShell } from "./mesh-shell";

// Ownership is checked by scene preview before reaching this function. Neither
// source bytes nor client-supplied validation receipts are trusted here.
export async function validateMeshShells(db: Db, sid: string, definition: PlaceSceneDefinition) {
  const bytes = new Map<string, Buffer>(), messages: string[] = [];
  for (const object of definition.objects.filter(o => o.kind === "building" && o.asset_id)) {
    const id = object.asset_id!;
    let data = bytes.get(id);
    if (!data) {
      const asset = await db.collection<MeshAssetDoc>("mesh_assets").findOne({ _id: `${sid}:${id}`, session_id: sid });
      if (!asset) throw new CreatorError("Mesh shell asset does not belong to this world", 403);
      const stored = await getStoredBytes(asset.key, AbortSignal.timeout(30_000));
      if (!stored || createHash("sha256").update(stored.bytes).digest("hex") !== asset.sha256) throw new CreatorError("Mesh shell asset is missing or corrupted", 503);
      data = stored.bytes;
      try { await inspectMeshImport(data); } catch (e) { throw new CreatorError(`Mesh shell validation: ${(e as Error).message}`, 422); }
      bytes.set(id, data);
    }
    try {
      const report = await withMeshGeometry(data, scene => inspectMeshShell(fitGeneratedMesh(scene, object), object));
      messages.push(`${object.label}: mesh shell validated (${report.triangles} triangles, ${report.free_volumes} free volumes)`);
    } catch (e) { throw new CreatorError(`${object.label}: ${(e as Error).message}`, 422); }
  }
  return messages;
}
