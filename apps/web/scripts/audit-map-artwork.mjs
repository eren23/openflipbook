import { MongoClient } from "mongodb";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Read-only receipt for an already reviewed map edit; never invokes a provider.
const [draftId, destination] = process.argv.slice(2);
if (!draftId || !destination) throw new Error("Usage: node --env-file=.env.local scripts/audit-map-artwork.mjs DRAFT OUTPUT");
const req = createRequire(import.meta.url), sharp = createRequire(req.resolve("next/package.json"))("sharp");
const client = new MongoClient(process.env.MONGODB_URI);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
await client.connect();
try {
  const db = client.db(process.env.MONGODB_DB), draft = await db.collection("sketches").findOne({ _id: draftId });
  if (!draft?.map_repaint) throw new Error("Not a geometry-bound map draft");
  const b = draft.map_repaint;
  const runs = await db.collection("sketch_runs").find({ draft_id: draftId }).toArray();
  const run = runs.find(r => r.saved_node_id);
  if (!run || run.mock || run.outside_changed !== 0) throw new Error("No accepted real protected result");
  const head = await db.collection("map_artwork_heads").findOne({ _id: `${draft.session_id}:${b.map_root_node_id}` });
  const scene = await db.collection("place_scenes").findOne({ session_id: draft.session_id, id: b.scene_id });
  const saved = await db.collection("place_scene_versions").findOne({ session_id: draft.session_id, place_id: b.place_id, revision: b.scene_revision });
  if (head?.node_id !== run.saved_node_id || scene.revision !== b.scene_revision || JSON.stringify(scene.definition) !== JSON.stringify(saved.definition)) throw new Error("Artwork head or geometry changed");
  const fetchImage = async id => {
    const response = await fetch(`http://127.0.0.1:3003/api/image/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Image read failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const before = await fetchImage(b.base_map_node_id), after = await fetchImage(run.saved_node_id);
  const a = await sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), c = await sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== c.info.width || a.info.height !== c.info.height) throw new Error("Frame changed");
  const masks = run.snapshot.state.scene.elements.filter(e => e.customData?.role === "mask" && !e.isDeleted);
  if (masks.some(e => e.angle)) throw new Error("This independent audit expects axis-aligned rectangles");
  let count = 0, outsideBounds = 0, left = a.info.width, top = a.info.height, right = 0, bottom = 0;
  for (let y = 0; y < a.info.height; y++) for (let x = 0; x < a.info.width; x++) {
    const i = (y * a.info.width + x) * 4;
    if (![0, 1, 2, 3].some(ch => a.data[i + ch] !== c.data[i + ch])) continue;
    count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    // Include Excalidraw's white mask stroke (one pixel either side).
    if (!masks.some(m => x >= Math.floor(m.x) - 2 && x <= Math.ceil(m.x + m.width) + 2 && y >= Math.floor(m.y) - 2 && y <= Math.ceil(m.y + m.height) + 2)) outsideBounds++;
  }
  if (!count || outsideBounds) throw new Error(`Pixel audit failed: ${count} changed, ${outsideBounds} outside reviewed mask bounds`);
  const output = resolve(destination); await mkdir(output, { recursive: true });
  await writeFile(`${output}/map-before.png`, before); await writeFile(`${output}/map-after.png`, after);
  const crop = { left: Math.max(0, left - 50), top: Math.max(0, top - 35), width: Math.min(a.info.width, right + 51) - Math.max(0, left - 50), height: Math.min(a.info.height, bottom + 36) - Math.max(0, top - 35) };
  for (const [name, bytes] of [["before", before], ["after", after]]) await sharp(bytes).extract(crop).resize({ width: 1200 }).png().toFile(`${output}/detail-${name}.png`);
  const receipt = { draft_id: draftId, session_id: draft.session_id, binding: b, saved_node_id: run.saved_node_id, geometry_unchanged: true, active_map_verified: true, mock: run.mock, backend_outside_changed: run.outside_changed, independent_outside_reviewed_bounds: outsideBounds, changed_pixels: count, changed_bounds: { left, top, right, bottom }, detail_crop: crop, source_sha256: hash(before), result_sha256: hash(after), runs: runs.map(r => ({ id: r._id, status: r.status, model: r.model, mock: r.mock, outside_changed: r.outside_changed, saved_node_id: r.saved_node_id ?? null, error: r.error ?? null })), limitations: "Manually registered authored footprints; visual edit, not exact map/mesh reconstruction. Rejected first real candidate retained blue guides." };
  await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { await client.close(); }
