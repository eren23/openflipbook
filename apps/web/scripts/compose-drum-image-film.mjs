import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// This cuts the recorded, paid run. It never calls a model or simulates UI.
const source = resolve(process.argv[2] || "../../docs/research/assets/ankh-image-first-take3");
const output = resolve(process.argv[3] || `${source}/image-first-20s.mp4`);
const receipt = JSON.parse(readFileSync(`${source}/receipt.json`, "utf8"));
if (receipt.status !== "complete" || receipt.candidate?.mock || receipt.candidate?.outside_changed !== 0) throw new Error("A real, completed and protected edit is required");
const times = Object.fromEntries(receipt.events.map(event => [event.name, event.seconds]));
const segments = [
  [times.map, times.mask_drawn + 0.4],
  [times.generation_start - 0.7, times.generation_start + 1.0],
  // Audit of this take: decoded images first appear at 56s and 72s.
  [Math.max(times.generation_complete + 2.2, times.edit_shown - 0.9), times.edit_shown + 2.0],
  [times.kept - 0.4, times.kept],
  [times.reloaded + 0.1, times.reloaded + 0.6],
];
const filters = segments.map(([start, end], i) => `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=30,setsar=1[v${i}]`);
filters.push("[1:v]scale=1440:1000:force_original_aspect_ratio=decrease,pad=1440:1000:(ow-iw)/2:(oh-ih)/2:color=0xf0f3f0,trim=duration=5,setpts=PTS-STARTPTS,fps=30,setsar=1[art]");
filters.push(`${segments.map((_, i) => `[v${i}]`).join("")}[art]concat=n=${segments.length + 1}:v=1:a=0[out]`);
const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", `${source}/image-first-uncut.webm`, "-loop", "1", "-i", resolve("public/demos/ankh-morpork/street-edit.png"), "-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-metadata", "comment=Actual native Sketch run; generation and save waits removed. Closing still is the saved candidate. Not a continuous 3D traversal.", "-y", output], { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status || 1);
console.log(JSON.stringify({ output, segments, closing_saved_image_seconds: 5, generation_wait_seconds: times.generation_complete - times.generation_start }));
