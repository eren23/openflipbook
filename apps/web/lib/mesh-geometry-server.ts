import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { CreatorError } from "./creator";
import { getStoredBytes } from "./r2";
import type { MeshAssetDoc } from "./mesh-execution";
import { measureMeshGlb } from "./mesh-geometry";

// Call only after ownership authorization. The cache belongs to immutable asset
// bytes, not to any placement or model job, and cannot submit paid work.
export async function savedMeshDimensions(db: Db, sid: string, id: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new CreatorError("Invalid mesh id", 400);
  const assets = db.collection<MeshAssetDoc>("mesh_assets");
  const asset = await assets.findOne({ _id: `${sid}:${id}`, session_id: sid });
  if (!asset) throw new CreatorError("Mesh not found in this world", 404);
  if (asset.geometry?.sha256 === asset.sha256) return asset.geometry.size;
  const stored = await getStoredBytes(asset.key, AbortSignal.timeout(30_000));
  if (!stored || createHash("sha256").update(stored.bytes).digest("hex") !== asset.sha256) throw new CreatorError("Saved mesh is missing or corrupted", 503);
  let size;
  try { size = await measureMeshGlb(stored.bytes); }
  catch { throw new CreatorError("Saved mesh geometry cannot be measured", 422); }
  await assets.updateOne({ _id: asset._id, sha256: asset.sha256 }, { $set: { geometry: { sha256: asset.sha256, size } } });
  return size;
}
