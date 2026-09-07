// Isolated browser fixture: local stores only; new IDs on every invocation.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { log } from "node:console";
import { MongoClient } from "mongodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const sessionId = `place-test-${randomUUID()}`;
const rootId = randomUUID();
const savedId = randomUUID();
const imageKey = `place-inspector-test/${sessionId}.jpg`;
const bytes = await readFile(new URL("../../modal-backend/tests/click_bench/fixtures/images/real/fishing_village.jpg", import.meta.url));
const s3 = new S3Client({ region: "auto", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "openflipbook", secretAccessKey: "openflipbook-local" } });
await s3.send(new PutObjectCommand({ Bucket: "openflipbook", Key: imageKey, Body: bytes, ContentType: "image/jpeg" }));
const client = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true");
await client.connect();
try {
  const db = client.db("openflipbook_healthcheck");
  const now = new Date();
  const base = { session_id: sessionId, query: "Crescent Bay Fishing Village", image_key: imageKey, image_model: "fixture", prompt_author_model: "fixture", aspect_ratio: "16:9", final_prompt: null, click_in_parent: null, created_at: now, sources: [], relation: "descend" };
  await db.collection("nodes").insertMany([
    { ...base, _id: rootId, parent_id: null, page_title: "Crescent Bay Fishing Village", scene_view: null },
    { ...base, _id: savedId, parent_id: rootId, page_title: "Saved North Point view", scene_view: { node_id: savedId, level: "building", observer: null, map_crop: null, focus_id: "north-point" } },
  ]);
  const cases = [
    ["north-point", "North Point Lighthouse", .557, .192, "White stone lighthouse with a red roof"],
    ["market", "Central Market Square", .414, .594, "An open square ringed by stalls"],
    ["market-hall", "Market Hall", .43, .594, "The timber hall beside the square"],
  ];
  const geos = cases.map(([id, label, x, y, visual]) => ({ id, entity_id: `entity-${id}`, kind: "place", label, pos: { x: x * 100, y: y * 60 }, footprint: { w: 12, d: 12 }, height: 8, visual, state: {}, confidence: 1, source: "user", updated_at: now.toISOString() }));
  await db.collection("world_map").insertOne({ _id: sessionId, entities: geos, bounds: { x: 0, y: 0, w: 100, h: 60 }, updated_at: now });
  await db.collection("world_state").insertOne({ _id: sessionId, entities: cases.map(([id, name, x, y, appearance]) => ({ id: `entity-${id}`, kind: "place", name, appearance, aliases: [], facts: [], state: {}, confidence: 1, pinned_by_user: false, first_seen_node_id: rootId, last_seen_node_id: rootId, appears_on_node_ids: [rootId], appearance_bboxes: { [rootId]: { x_pct: x - .06, y_pct: y - .1, w_pct: .12, h_pct: .2 } }, created_at: now, updated_at: now })), updated_at: now });
  log(JSON.stringify({ sessionId, rootId, savedId, url: `http://127.0.0.1:3001/n/${rootId}` }));
} finally {
  await client.close();
  s3.destroy();
}
