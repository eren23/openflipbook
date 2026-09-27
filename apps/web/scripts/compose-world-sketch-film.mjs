import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(process.argv[2] || "../../docs/research/assets/world-sketch-sync-take4-2026-09-11");
const output = resolve(process.argv[3] || `${source}/sketch-to-world.mp4`);
const receipt = JSON.parse(readFileSync(`${source}/receipt.json`, "utf8"));
if (receipt.status !== "complete" || receipt.errors.length || !receipt.checks?.geometry_and_map_match || !receipt.checks?.reference_image_unchanged || receipt.model_calls !== 0) throw new Error("A verified, real sketch-to-world recording is required");
const t = Object.fromEntries(receipt.events.map(e => [e.name, e.seconds]));
const segments = [[t.before, t.review + 1.2], [t.saved, t.saved + 0.8], [t.reloaded, t.end]];
const filters = segments.map(([start, end], n) => `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=30,setsar=1[v${n}]`);
filters.push(`${segments.map((_, n) => `[v${n}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`);
const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", `${source}/uncut.webm`, "-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-metadata", "comment=Actual footprint drawing and building edits in synchronized Plan and 3D; world-map records checked after real save/reload. Import and persistence waits removed. Illustrated source pixels are unchanged. No new model calls.", "-y", output], { stdio: "inherit" });
if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.status}`);
writeFileSync(`${source}/film-receipt.json`, JSON.stringify({ output, segments, source_receipt: `${source}/receipt.json`, audio: "none", edit: "Import and save/reload waits omitted; scene edits and drawing shown as recorded" }, null, 2));
console.log(output);
