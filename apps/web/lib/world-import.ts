import type { Document } from "mongodb";
import { getDb, withDbTransaction } from "./db";
import { getExistingOwnerToken } from "./session-owner";
import { getStoredBytes, uploadJpeg } from "./r2";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";
import { archiveHash, readWorldArchive } from "./world-import-archive";
import { prepareWorldImport, type WorldImportPlan } from "./world-import-content";

interface ImportReceipt {
  _id: string; sha256: string; key: string; session_id: string;
  preview: WorldImportPlan["preview"]; status: "preview" | "applied";
  created_at: Date; applied_at?: Date;
}
async function identity(requestId: string) {
  if (!isSafeId(requestId)) throw new CreatorError("Invalid import identity", 400);
  const token = await getExistingOwnerToken();
  if (!token) throw new CreatorError("Initialize this browser's workspace before importing", 409);
  const key = archiveHash(JSON.stringify([token, requestId]));
  return { token, key, sid: `session_${key}` };
}
const wire = (requestId: string, receipt: ImportReceipt) => ({ request_id: requestId, sha256: receipt.sha256, status: receipt.status, session_id: receipt.session_id, preview: receipt.preview });
export async function inspectWorldImport(requestId: string, bytes: Buffer) {
  const { key, sid } = await identity(requestId), db = await getDb(), col = db.collection<ImportReceipt>("world_imports"), digest = archiveHash(bytes);
  const prior = await col.findOne({ _id: key });
  if (prior) {
    if (prior.sha256 !== digest) throw new CreatorError("Import request already belongs to another archive", 409);
    if (prior.status === "preview") {
      const stored = await getStoredBytes(prior.key, AbortSignal.timeout(30_000));
      if (!stored || archiveHash(stored.bytes) !== digest) await uploadJpeg(prior.key, bytes, "application/zip", AbortSignal.timeout(90_000));
    }
    return wire(requestId, prior);
  }
  let plan: WorldImportPlan;
  try { plan = await prepareWorldImport(await readWorldArchive(bytes), sid); }
  catch (e) { if (e instanceof CreatorError) throw e; throw new CreatorError(`Archive validation failed: ${(e as Error).message.slice(0, 250)}`, 422); }
  const storageKey = `${sid}/import-source/${digest}.zip`;
  await uploadJpeg(storageKey, bytes, "application/zip", AbortSignal.timeout(90_000));
  await col.updateOne({ _id: key }, { $setOnInsert: { _id: key, sha256: digest, key: storageKey, session_id: sid, preview: plan.preview, status: "preview", created_at: new Date() } }, { upsert: true });
  const saved = await col.findOne({ _id: key });
  if (!saved || saved.sha256 !== digest) throw new CreatorError("Import request already belongs to another archive", 409);
  return wire(requestId, saved);
}
export async function readWorldImport(requestId: string) {
  const { key } = await identity(requestId), receipt = await (await getDb()).collection<ImportReceipt>("world_imports").findOne({ _id: key });
  if (!receipt) throw new CreatorError("Import preview not found", 404);
  return wire(requestId, receipt);
}
export async function applyWorldImport(requestId: string, digest: unknown) {
  const { token, key, sid } = await identity(requestId), db = await getDb();
  const receipt = await db.collection<ImportReceipt>("world_imports").findOne({ _id: key });
  if (!receipt || receipt.sha256 !== digest) throw new CreatorError("Import preview changed or is unavailable", 409);
  async function replay() {
    const owner = await db.collection<{ _id: string; owner_token: string }>("session_owners").findOne({ _id: sid });
    if (owner?.owner_token !== token) throw new CreatorError("Imported world ownership is unavailable", 403);
    return wire(requestId, { ...receipt!, status: "applied" });
  }
  if (receipt.status === "applied") return replay();
  const source = await getStoredBytes(receipt.key, AbortSignal.timeout(90_000));
  if (!source || archiveHash(source.bytes) !== digest) throw new CreatorError("Staged archive is missing or corrupted. Re-upload the original archive.", 503);
  const plan = await prepareWorldImport(await readWorldArchive(source.bytes), sid);
  for (const upload of plan.uploads) {
    await uploadJpeg(upload.key, upload.bytes, upload.contentType, AbortSignal.timeout(90_000));
    const stored = await getStoredBytes(upload.key, AbortSignal.timeout(90_000));
    if (!stored || stored.bytes.length !== upload.bytes.length || archiveHash(stored.bytes) !== archiveHash(upload.bytes)) throw new CreatorError("Imported asset storage verification failed. Retry the import.", 503);
  }
  try {
    return await withDbTransaction(async (database, session) => {
      const options = { session }, imports = database.collection<ImportReceipt>("world_imports");
      const current = await imports.findOne({ _id: key }, options);
      if (!current || current.sha256 !== digest) throw new CreatorError("Import preview changed", 409);
      const owners = database.collection<{ _id: string; owner_token: string; created_at: Date }>("session_owners");
      const owner = await owners.findOne({ _id: sid }, options);
      if (current.status === "applied") { if (owner?.owner_token !== token) throw new CreatorError("Imported world ownership is unavailable", 403); return wire(requestId, current); }
      if (owner) throw new CreatorError("Import destination already exists", 409);
      for (const [collection, docs] of Object.entries(plan.records)) if (docs.length) await database.collection<Document>(collection).insertMany(docs, options);
      await owners.insertOne({ _id: sid, owner_token: token, created_at: new Date() }, options);
      await imports.updateOne({ _id: key, status: "preview", sha256: receipt.sha256 }, { $set: { status: "applied", applied_at: new Date() } }, options);
      return wire(requestId, { ...receipt, status: "applied" });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const committed = await db.collection<ImportReceipt>("world_imports").findOne({ _id: key });
      if (committed?.status === "applied" && committed.sha256 === digest) return replay();
    }
    throw e;
  }
}
