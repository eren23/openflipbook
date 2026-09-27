import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const source = resolve("../../docs/research/assets/drum-geometry");
const output = resolve(process.argv[2] || `${source}/geometry-proof.mp4`);
const receipt = JSON.parse(readFileSync(`${source}/receipt.json`, "utf8"));
if (receipt.status !== "complete" || receipt.errors.length) throw new Error("A successful browser recording is required");
const t = Object.fromEntries(receipt.events.map(event => [event.name, event.seconds]));
const segments = [
  [t.textured + 0.2, t.textured + 1.3, 1.1],
  [t.textured + 1.5, t.second_view, 5],
  [t.roof_edit - 0.4, t.roof_edit + 1.5, 1.9],
  [t.roof_edit + 2, t.return, 5],
  [t.alignment + 0.2, t.alignment + 1.5, 1.3],
  [t.end + 0.2, t.end + 1, 0.8],
];
const filters = segments.map(([start, end, duration], i) => `[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)*${duration / (end - start)},fps=30[v${i}]`);
filters.push(`${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`);
const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", `${source}/uncut.webm`, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-metadata", "comment=Actual Three.js study. Camera travel accelerated; UI pauses trimmed. Partial geometry fit, synthesized materials, explicit mesh roof edit.", "-y", output], { stdio: "inherit" });
if (result.status) process.exit(result.status);
console.log(JSON.stringify({ output, segments }));
