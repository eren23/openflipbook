import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDb } from "../lib/db";
import { processNextPlaceBuild, type PlaceBuildWorkerDoc } from "../lib/place-build-execution";
import { processNextMeshJob, processNextAssetJob } from "../lib/mesh-execution";
import { readServerEnv, requireR2 } from "../lib/env";
import { MongoServerError } from "mongodb";
import { processNextMotionJob } from "../lib/motion-execution";
import { processNextPathVideo } from "../lib/path-video";
import { motionVideoToolsAvailable } from "../lib/motion-video";

// Configuration is explicit: Docker supplies environment variables; local
// operators can use `node --env-file=.env.local --import tsx ...`.
async function main() {
  if (!process.env.MODAL_API_URL || !process.env.SHARED_TOKEN) throw new Error("Layout worker requires MODAL_API_URL and SHARED_TOKEN");
  process.stdout.write("Opening generation database and checking indexes\n");
  const db = await getDb(), id = randomUUID();
  const workers = db.collection<PlaceBuildWorkerDoc>("generation_workers");
  let mesh = false;
  try { requireR2(readServerEnv()); mesh = true; } catch { process.stderr.write("Mesh and material processing disabled: asset storage is not configured\n"); }
  const motion = mesh && await motionVideoToolsAvailable();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const heartbeat = () => workers.updateOne({ _id: id }, { $set: { kind: "place-layout", layout_connections: true, layout_floor_targets: true, mesh, mesh_image: mesh, material: mesh, illustration: mesh, illustration_region: mesh, illustration_brush: mesh, illustration_identity: mesh, illustration_keyframe: mesh, motion_v1: motion, motion_review_v1: motion, path_video_v1: motion, path_video_views_v1: motion, last_seen: new Date() } }, { upsert: true });
  await heartbeat();
  const timer = setInterval(() => { void heartbeat().catch(() => process.stderr.write("Layout worker heartbeat unavailable\n")); }, 5000);
  process.stdout.write(`Layout worker ready; mesh and material processing ${mesh ? "enabled" : "disabled"}\n`);
  try {
    const loop = async (next: () => Promise<boolean>) => {
      while (!stopping) {
        try { if (await next()) continue; }
        catch { process.stderr.write("Generation storage unavailable; paid submissions are not retried\n"); }
        if (!stopping) await delay(1000);
      }
    };
    // Independent layout, mesh and material lanes keep long layout calls from
    // delaying retrieval of already-paid assets before their URLs expire.
    await Promise.all([loop(() => processNextPlaceBuild(db)), ...(mesh ? [loop(() => processNextMeshJob(db)), loop(() => processNextAssetJob(db, "material")), loop(() => processNextAssetJob(db, "illustration"))] : []), ...(motion ? [loop(() => processNextMotionJob(db)), loop(() => processNextPathVideo(db))] : [])]);
  } finally {
    clearInterval(timer);
    // SIGTERM drains the in-flight operations. SIGKILL leaves a paid claim
    // ambiguous; another worker must not resubmit it.
    await workers.deleteOne({ _id: id });
  }
}
try { await main(); }
catch (e) {
  const reason = e instanceof MongoServerError ? `MongoDB code ${e.code ?? "unknown"}; check database permissions, collection/index quotas and replica-set health`
    : e instanceof Error && e.message.startsWith("Layout worker requires") ? e.message : "check database connectivity and worker configuration";
  process.stderr.write(`Layout worker failed to initialize: ${reason}\n`); process.exitCode = 1;
}
finally { await globalThis.__endlessCanvasMongo?.client.close(); }
