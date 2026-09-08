/** Offline source-pixel renders. No browser, providers, or network access.
 * pnpm exec tsx spatial-study.ts [output-directory]
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { objectContainRect } from "../../apps/web/lib/image-click";
import { planSpatialTransition, sampleReframe, type ReframePlan, type SpatialFrame } from "../../apps/web/lib/spatial-transition";
import { SPATIAL_STUDY_CASES, spatialAssetPath } from "../../apps/web/lib/spatial-study";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const out = resolve(process.argv[2] ?? resolve(here, "artifacts-spatial"));
const require = createRequire(resolve(root, "apps/web/package.json"));
const jpeg = require("jpeg-js") as typeof import("../../apps/web/node_modules/jpeg-js");
type Bitmap = { width: number; height: number; data: Uint8Array };
const width = 960, height = 540, fps = 30;
function decodeFile(path: string): Bitmap {
  const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], { encoding: "utf8" })).streams[0];
  return { ...metadata, data: execFileSync("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 }) };
}

function render(image: Bitmap, plan: ReframePlan | null, progress: number): Buffer {
  const frame = Buffer.alloc(width * height * 3, 17);
  const rect = objectContainRect(width, height, image.width, image.height)!;
  const m = plan ? sampleReframe(plan, progress) : { scale: 1, x: 0, y: 0 };
  for (let y = Math.ceil(rect.offsetY); y < rect.offsetY + rect.height; y++) for (let x = Math.ceil(rect.offsetX); x < rect.offsetX + rect.width; x++) {
    const u = ((x - rect.offsetX) / rect.width - m.x) / m.scale;
    const v = ((y - rect.offsetY) / rect.height - m.y) / m.scale;
    const i = (Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height))) * image.width + Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)))) * 4;
    const j = (y * width + x) * 3;
    frame[j] = image.data[i]!; frame[j + 1] = image.data[i + 1]!; frame[j + 2] = image.data[i + 2]!;
  }
  return frame;
}
function still(rgb: Buffer) {
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) rgb.copy(rgba, i * 4, i * 3, i * 3 + 3);
  return jpeg.encode({ data: rgba, width, height }, 92).data;
}
async function movie(name: string, getFrame: (time: number) => Buffer) {
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out, name)], { stdio: ["pipe", "inherit", "inherit"] });
  const finished = once(ffmpeg, "exit");
  for (let frame = 0; frame < fps * 4; frame++) if (!ffmpeg.stdin.write(getFrame(frame * 1000 / fps))) await once(ffmpeg.stdin, "drain");
  ffmpeg.stdin.end();
  const [code] = await finished;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

await mkdir(out, { recursive: true });
const receipts = [];
for (const [index, fixture] of SPATIAL_STUDY_CASES.entries()) for (const scene of [false, true]) {
  const sourceName = scene ? `${fixture.id}-destination.jpg` : fixture.source;
  const sourceBytes = await readFile(resolve(root, "apps/modal-backend", spatialAssetPath(sourceName)!));
  const destinationBytes = await readFile(resolve(root, "apps/modal-backend", spatialAssetPath(`${fixture.id}-destination.jpg`)!));
  const source = decodeFile(resolve(root, "apps/modal-backend", spatialAssetPath(sourceName)!));
  const destination = decodeFile(resolve(root, "apps/modal-backend", spatialAssetPath(`${fixture.id}-destination.jpg`)!));
  const from: SpatialFrame = { id: "source", parentId: null, image: sourceName, view: { node_id: "source", level: scene ? "eye" : "map", observer: null, map_crop: null } };
  const to: SpatialFrame = { id: "destination", parentId: "source", image: "destination", click: { x_pct: scene ? [.15, .5, .85][index]! : fixture.x, y_pct: scene ? .55 : fixture.y } };
  const plan = planSpatialTransition(from, to) as ReframePlan;
  const prefix = `${fixture.id}-${scene ? "scene-control" : "map"}`;
  const cut = 500 + plan.duration + plan.hold;
  const arrival = scene ? render(source, plan, 1) : render(destination, null, 0);
  await movie(`${prefix}-forward.mp4`, time => time >= cut ? arrival : render(source, plan, Math.max(0, (time - 500) / plan.duration)));
  await movie(`${prefix}-back.mp4`, time => time < 500 ? arrival : render(source, plan, Math.max(0, 1 - (time - 500) / plan.duration)));
  for (const progress of [0, .5, 1]) await writeFile(resolve(out, `${prefix}-${progress}.jpg`), still(render(source, plan, progress)));
  await writeFile(resolve(out, `${prefix}-arrival.jpg`), still(arrival));
  if (!scene) {
    const clips = [fixture.h3, fixture.ltx].map(name => resolve(root, "apps/modal-backend", spatialAssetPath(name)!));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", resolve(out, `${prefix}-forward.mp4`), "-i", clips[0]!, "-i", clips[1]!, "-filter_complex", "[0:v]scale=640:360,setsar=1,tpad=stop_mode=clone:stop_duration=4[a];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=start_mode=clone:start_duration=0.5[b];[2:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=start_mode=clone:start_duration=0.5[c];[a][b][c]hstack=inputs=3[v]", "-map", "[v]", "-an", "-t", "7.1", "-r", "30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", resolve(out, `${prefix}-comparison-pixels-h3-ltx.mp4`)]);
  }
  receipts.push({ case: prefix, source_sha256: createHash("sha256").update(sourceBytes).digest("hex"), destination_sha256: scene ? null : createHash("sha256").update(destinationBytes).digest("hex"), target: plan.target, fraction: plan.fraction, duration_ms: plan.duration, hold_ms: plan.hold, study_intro_hold_ms: 500, identity: scene ? "same-image crop control" : `FAIL: ${fixture.title} -> ${fixture.destination}`, continuity: "not human-rated", motion: "shared affine planner; numerical invariants tested", new_model_calls: 0 });
  console.log(prefix);
}
await writeFile(resolve(out, "receipt.json"), JSON.stringify({ new_model_calls: 0, new_model_cost_usd: 0, comparison_order: ["source pixels", "saved H3", "saved LTX"], export_sampling: "nearest-neighbor; browser uses its native image resampling; identical transforms", cases: receipts }, null, 2));
console.log(out);
