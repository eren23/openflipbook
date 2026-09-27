// Curated real outputs, isolated local stores only. No provider calls or remote publish.
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const root = new URL("../../../", import.meta.url);
const reports = new URL("apps/modal-backend/tests/continuity_bench/reports/connected-demo/", root);
const manifestPath = new URL("local-world.json", reports);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const selection = [
  { name: "root", title: "Aethelgard Harbor", parent: null, level: "map", click: null },
  // Corrected by inspecting the actual stalls. The original prompt receipt
  // retains its draft coordinate; this is the reviewed navigation coordinate.
  { name: "market", shot: "market-1", title: "Quayside Market", parent: "root", level: "street", click: [.656, .354] },
  { name: "interior", shot: "interior-1", title: "Inside Quayside Provisions", parent: "market", level: "eye", click: [.912, .702] },
  { name: "lighthouse", shot: "lighthouse-2", title: "Crystal Lighthouse", parent: "root", level: "building", click: [.139, .307] },
];
const source = new URL("apps/modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg", root);
// Validate every review and byte hash before touching either data store.
const assets = [];
for (const item of selection) {
  const path = item.shot ? new URL(`${item.shot}.png`, reports) : source;
  const bytes = await readFile(path);
  const receipt = item.shot ? await readJson(new URL(`${item.shot}-receipt.json`, reports)) : null;
  if (receipt && (receipt.state !== "complete" || receipt.review?.accepted !== true || receipt.output_sha256 !== sha(bytes))) {
    throw new Error(`Unreviewed, rejected or changed image: ${item.shot}`);
  }
  assets.push({ ...item, path: fileURLToPath(path), bytes, receipt, sha256: sha(bytes) });
}
let existing;
try { existing = await readJson(manifestPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!assets.every(a => existing.nodes[a.name]?.sha256 === a.sha256)) throw new Error("Saved demo differs; do not overwrite it");
  console.log(JSON.stringify(existing));
} else {
  const session = `connected-demo-${randomUUID()}`;
  const ids = Object.fromEntries(assets.map(a => [a.name, randomUUID()]));
  const keys = Object.fromEntries(assets.map(a => [a.name, `connected-demo/${session}/${a.name}.${a.shot ? "png" : "jpg"}`]));
  const views = Object.fromEntries(assets.map(a => [a.name, { node_id: ids[a.name], level: a.level, observer: null, map_crop: null, focus_id: null }]));
  const s3 = new S3Client({ region: "auto", endpoint: "http://127.0.0.1:9000", forcePathStyle: true,
    credentials: { accessKeyId: "openflipbook", secretAccessKey: "openflipbook-local" } });
  const client = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true");
  try {
    await client.connect();
    const db = client.db("openflipbook_healthcheck");
    for (const a of assets) await s3.send(new PutObjectCommand({ Bucket: "openflipbook", Key: keys[a.name],
      Body: a.bytes, ContentType: a.shot ? "image/png" : "image/jpeg" }));
    const now = new Date();
    await db.collection("nodes").insertMany(assets.map((a, index) => {
      const click = a.click ? { x_pct: a.click[0], y_pct: a.click[1] } : null;
      return { _id: ids[a.name], session_id: session, parent_id: a.parent ? ids[a.parent] : null,
        page_title: a.title, query: a.title, image_key: keys[a.name], image_model: a.receipt?.model ?? "existing-world-artwork",
        prompt_author_model: "manually-directed-demo", final_prompt: a.receipt?.arguments.prompt ?? null,
        aspect_ratio: "16:9", sources: [], relation: "descend", click_in_parent: click,
        scene_view: views[a.name], view_verdict: null, created_at: new Date(now.getTime() + index),
        transition_context: a.parent ? { version: 1, source_node_id: ids[a.parent], source_image_key: keys[a.parent],
          target_point: click, target_geo_id: null, target_bbox: null, target_provenance: "tap",
          source_view: views[a.parent], destination_view: views[a.name] } : null,
        demo_provenance: { curated: true, source_sha256: a.sha256, shot: a.shot ?? null,
          request_id: a.receipt?.request_id ?? null, geometry_verified: false },
      };
    }));
    // The existing embed is publish-gated. This record exists only in the
    // hard-coded localhost test DB, never in the user's remote world store.
    await db.collection("published_sessions").insertOne({ _id: session, node_id: ids.root,
      title: "Aethelgard Harbor", query: "Curated connected demo", poster_key: keys.root, published_at: now });
    const manifest = { version: 1, session, url: `http://127.0.0.1:3002/embed/${session}`, local_only: true,
      curated: true, geometry_verified: false, nodes: Object.fromEntries(assets.map(a => [a.name,
        { id: ids[a.name], title: a.title, parent: a.parent, click: a.click, image_key: keys[a.name],
          source_path: a.path, sha256: a.sha256, shot: a.shot ?? null }])),
      route: ["root", "market", "interior", "market", "root", "lighthouse", "root", "market", "root"] };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify(manifest));
  } finally { await client.close(); s3.destroy(); }
}
