import { test, expect } from "@playwright/test";
import { CreateBucketCommand, PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BSON, Long, MongoClient, ObjectId } from "mongodb";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createOperatorBackup, restoreOperatorBackup } from "../lib/operator-backup";
import { operatorMongo, operatorS3 } from "../scripts/operator-backup";
import { assertSelfhostReceipt } from "./selfhost-environment";

test.skip(process.env.E2E_SELFHOST !== "1", "Requires the isolated credential-free selfhost receipt");
test("real Mongo/S3 operator recovery preserves private records, indexes and exact bytes", async ({ request, baseURL }) => {
  test.setTimeout(120_000);
  const receipt = JSON.parse(await readFile(process.env.E2E_SELFHOST_RECEIPT!, "utf8"));
  assertSelfhostReceipt(receipt, baseURL);
  const config = JSON.parse(await readFile(receipt.compose_file, "utf8"));
  const minio = config.services.minio;
  if (config.name !== receipt.project || minio.ports[0].host_ip !== "127.0.0.1" || minio.environment.RUSTFS_ACCESS_KEY !== "selfhost-check") throw new Error("Expected private isolated S3 configuration");
  await expect.poll(async () => { try { return (await request.get("/api/status")).status(); } catch { return 0; } }, { timeout: 120_000 }).toBe(200);
  const storageEndpoint = `http://127.0.0.1:${minio.ports[0].published}`;
  const client = new MongoClient(receipt.mongo), s3 = new S3Client({ region: "us-east-1", endpoint: storageEndpoint, forcePathStyle: true,
    credentials: { accessKeyId: minio.environment.RUSTFS_ACCESS_KEY, secretAccessKey: minio.environment.RUSTFS_SECRET_KEY } });
  const directory = await mkdtemp(join(tmpdir(), "selfhost-operator-"));
  try {
    await client.connect();
    // These stores are separate from the browser fixture database/bucket and
    // have no application writers. No user store or job is read or modified.
    const source = client.db("selfhost_operator_source"), target = client.db("selfhost_operator_restored");
    const sourceBucket = "selfhost-operator-source", targetBucket = "selfhost-operator-restored";
    await s3.send(new CreateBucketCommand({ Bucket: sourceBucket })); await s3.send(new CreateBucketCommand({ Bucket: targetBucket }));
    const world = "fixture-world", owner = new ObjectId(), date = new Date("2026-01-01T00:00:00Z");
    await source.collection("session_owners").insertOne({ _id: owner, session_id: world, owner_token: "fixture-private-owner", created_at: date });
    await source.collection("session_owners").createIndex({ owner_token: 1 }, { unique: true, name: "backup_owner_idx" });
    await source.collection("creator_notes").insertOne({ session_id: world, text: "Private fixture note", updated_at: date });
    await source.collection("generation_spend").insertOne({ session_id: world, units: Long.fromString("9007199254740993"), committed: 1.25 });
    await source.collection("path_videos").insertOne({ session_id: world, status: "needs_review", provider_request_id: "fixture-provider-receipt", reservation: 0, committed: 1.25 });
    for (const name of ["world_publications", "publication_libraries", "publication_forks"]) await source.collection(name).insertOne({ session_id: world, fixture: true });
    const key = `${world}/media.bin`, bytes = Buffer.from([0, 1, 255, 8, 0]), sha256 = createHash("sha256").update(bytes).digest("hex");
    await s3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: bytes, ContentType: "application/octet-stream", CacheControl: "private, no-store", Metadata: { sha256 } }));
    const manifest = await createOperatorBackup(join(directory, "backup"), operatorMongo(client, source.databaseName), operatorS3(s3, sourceBucket));
    const result = await restoreOperatorBackup(join(directory, "backup"), operatorMongo(client, target.databaseName), operatorS3(s3, targetBucket));
    expect(result.state).toBe("applied");
    for (const c of manifest.collections) {
      const original = await source.collection(c.name).find({}).sort({ _id: 1 }).toArray(), restored = await target.collection(c.name).find({}).sort({ _id: 1 }).toArray();
      expect(BSON.EJSON.stringify(restored, { relaxed: false })).toBe(BSON.EJSON.stringify(original, { relaxed: false }));
    }
    expect(await target.collection("session_owners").listIndexes().toArray()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "backup_owner_idx", unique: true })]));
    const got = await s3.send(new GetObjectCommand({ Bucket: targetBucket, Key: key }));
    expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(bytes); expect(got.CacheControl).toBe("private, no-store"); expect(got.Metadata?.sha256).toBe(sha256);
    expect((await request.get(`${storageEndpoint}/${targetBucket}/${key}`)).status()).toBe(403);
    expect((await restoreOperatorBackup(join(directory, "backup"), operatorMongo(client, target.databaseName), operatorS3(s3, targetBucket))).replay).toBe(true);
    await writeFile(test.info().outputPath("operator-backup-receipt.json"), JSON.stringify({ scope: manifest.scope, collections: manifest.collections.map(c => ({ name: c.name, rows: c.rows, sha256: c.sha256 })), objects: [{ bytes: bytes.length, sha256 }], restored: true, replay: true, model_spend: 0 }, null, 2));
  } finally { await client.close(); s3.destroy(); await rm(directory, { recursive: true, force: true }); }
});
