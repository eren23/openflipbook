import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MongoClient, type CreateCollectionOptions, type Document, type IndexDescription } from "mongodb";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readServerEnv, requireMongo, requireR2 } from "../lib/env";
import { createOperatorBackup, restoreOperatorBackup, type OperatorDatabase, type OperatorBlobStore, type OperatorRestoreReceipt } from "../lib/operator-backup";
import { r2ClientConfig } from "../lib/r2-client-config";

const help = `Full operator backup/restore. Stop web and workers and drain providers first.
  backup --directory /backups/new-directory --quiesced
  restore --directory /backups/existing-directory --quiesced --empty-destination

Uses configured MongoDB and private S3 bucket. Restore preserves ownership,
notes, job states and spend ledgers; services stay stopped. Review queued and
submitted jobs before starting workers. World ZIP import is a separate feature.
Backup directories contain secrets and must be encrypted and restricted.`;
export function parseBackupCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: "string" }, quiesced: { type: "boolean" }, "empty-destination": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help && !positionals.length) return { action: "help" as const };
  if (positionals.length !== 1 || values.help || !values.directory || !values.quiesced
    || !["backup", "restore"].includes(positionals[0] ?? "") || (positionals[0] === "restore") !== Boolean(values["empty-destination"])) throw new Error(help);
  return { action: positionals[0] as "backup" | "restore", directory: resolve(values.directory) };
}
export function operatorMongo(client: MongoClient, database: string): OperatorDatabase {
  const db = client.db(database), receipts = db.collection<OperatorRestoreReceipt>("operator_restore_receipts");
  return {
    name: database,
    async inventory() {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      return await Promise.all(collections.filter(c => !c.name.startsWith("system.")).map(async c => {
        if (c.type !== "collection") throw new Error("Database views need separate operator backup support");
        return { name: c.name, options: c.options ?? {}, indexes: await db.collection(c.name).listIndexes().toArray() };
      }));
    },
    rows: name => db.collection(name).find({}),
    receipt: id => receipts.findOne({ _id: id }),
    async beginRestore(id) { await receipts.insertOne({ _id: id, state: "copying" }); },
    async importMetadata(manifest, readRows, id) {
      const permitted = new Set([...manifest.collections.map(c => c.name), "operator_restore_receipts"]);
      for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
        if (!permitted.has(c.name)) throw new Error("Unexpected collection during restore");
        const count = await db.collection(c.name).countDocuments({});
        if (count !== (c.name === "operator_restore_receipts" ? 1 : 0)) throw new Error("Destination database changed during restore");
      }
      // Collections must exist before the metadata transaction; creation retries
      // are safe because we verified that no ordinary rows have been written.
      const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
      for (const c of manifest.collections) if (!existing.has(c.name)) await db.createCollection(c.name, c.options as CreateCollectionOptions);
      const session = client.startSession();
      try { await session.withTransaction(async () => {
        for (const c of manifest.collections) {
          let batch: Document[] = [];
          for await (const row of readRows(c.file)) {
            batch.push(row);
            if (batch.length === 500) { await db.collection(c.name).insertMany(batch, { session }); batch = []; }
          }
          if (batch.length) await db.collection(c.name).insertMany(batch, { session });
        }
        const applied = await receipts.updateOne({ _id: id, state: "copying" }, { $set: { state: "data_imported" } }, { session });
        if (applied.matchedCount !== 1) throw new Error("Restore receipt changed during metadata import");
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); }
      finally { await session.endSession(); }
    },
    async finishRestore(manifest, id) {
      for (const c of manifest.collections) {
        const indexes = c.indexes.filter(index => index.name !== "_id_").map(index => {
          const { v: _v, ns: _ns, background: _background, ...definition } = index;
          return definition as IndexDescription;
        });
        if (indexes.length) await db.collection(c.name).createIndexes(indexes);
      }
      const applied = await receipts.updateOne({ _id: id, state: "data_imported" }, { $set: { state: "applied" } });
      if (applied.matchedCount !== 1) throw new Error("Restore receipt changed during index recovery");
    },
  };
}
export function operatorS3(s3: S3Client, bucket: string): OperatorBlobStore {
  return {
    bucket,
    async *keys() {
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ...(token ? { ContinuationToken: token } : {}) }), { abortSignal: AbortSignal.timeout(120_000) });
        for (const row of page.Contents ?? []) if (row.Key) yield row.Key;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new Error("Incomplete S3 object inventory");
      } while (token);
    },
    async read(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(120_000) });
      if (!response.Body) throw new Error("Backup object body missing");
      return { body: response.Body as AsyncIterable<Uint8Array>, metadata: {
        ...(response.ContentType ? { content_type: response.ContentType } : {}), ...(response.CacheControl ? { cache_control: response.CacheControl } : {}),
        ...(response.ContentDisposition ? { content_disposition: response.ContentDisposition } : {}), ...(response.ContentEncoding ? { content_encoding: response.ContentEncoding } : {}),
        ...(response.ContentLanguage ? { content_language: response.ContentLanguage } : {}), ...(response.Metadata ? { metadata: response.Metadata } : {}),
      } };
    },
    async write(key, body, bytes, meta) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Readable.from(body), ContentLength: bytes,
        ...(meta.content_type ? { ContentType: meta.content_type } : {}), ...(meta.cache_control ? { CacheControl: meta.cache_control } : {}),
        ...(meta.content_disposition ? { ContentDisposition: meta.content_disposition } : {}), ...(meta.content_encoding ? { ContentEncoding: meta.content_encoding } : {}),
        ...(meta.content_language ? { ContentLanguage: meta.content_language } : {}), ...(meta.metadata ? { Metadata: meta.metadata } : {}),
      }), { abortSignal: AbortSignal.timeout(120_000) });
    },
  };
}
async function main() {
  const command = parseBackupCommand(process.argv.slice(2));
  if (command.action === "help") { process.stdout.write(help + "\n"); return; }
  const env = readServerEnv(), mongo = requireMongo(env), r2 = requireR2(env), client = new MongoClient(mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  const s3 = new S3Client(r2ClientConfig(r2));
  try {
    await client.connect();
    const db = operatorMongo(client, mongo.db), store = operatorS3(s3, r2.bucket);
    const result = command.action === "backup" ? await createOperatorBackup(command.directory, db, store) : await restoreOperatorBackup(command.directory, db, store);
    process.stdout.write(JSON.stringify({ action: command.action, directory: command.directory, database: mongo.db, bucket: r2.bucket,
      ...(command.action === "backup" ? { collections: "collections" in result ? result.collections.length : 0, objects: "objects" in result ? result.objects.length : 0 } : result) }) + "\n");
  } finally { await client.close(); s3.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : "Operator backup failed") + "\n"); process.exitCode = 1;
});
