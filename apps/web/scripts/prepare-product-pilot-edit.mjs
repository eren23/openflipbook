import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(process.argv[2] || "docs/research/assets/product-pilot-take2-2026-09-11");
const source = process.argv[3] || resolve(homedir(), "Desktop/openflipbook-product-pilot-SOURCE-2026-09-11.mp4");
const output = resolve(root, "imovie-input");
const proof = JSON.parse(readFileSync(resolve(root, "receipt.json"), "utf8"));
if (proof.status !== "complete" || proof.generation_submissions !== 0 || proof.result?.object?.roof_material !== "teal") throw new Error("A verified roof-material source capture is required");
mkdirSync(output, { recursive: true });
const shots = [
  { name: "01-Draw-the-footprint", start: .4, end: 4.6, title: "Draw the footprint" },
  { name: "02-Set-the-height", start: 5.5, end: 8.9, title: "Set the height" },
  { name: "03-Inspect-every-angle", start: 8.9, end: 15.2, title: "Inspect every angle" },
  { name: "04-Change-the-roof-and-save", start: 15.2, end: 19.8, title: "Change the roof. Save." },
  { name: "05-Saved-after-reload", start: 25.1, end: 27.7, title: "Saved after reload", detail: "Save/reload wait omitted" },
];
let frame = 0;
for (const shot of shots) {
  shot.frames = Math.round((shot.end - shot.start) * 25);
  shot.timeline_start = frame / 25;
  frame += shot.frames;
  shot.file = resolve(output, `${shot.name}.mp4`);
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(shot.start), "-i", source, "-frames:v", String(shot.frames), "-an", "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", shot.file], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Could not prepare ${shot.name}`);
}
writeFileSync(resolve(output, "edit-manifest.json"), JSON.stringify({ source, duration: frame / 25, native_fps: 25, editor: "iMovie", stage: "prepared_media_not_final_export", source_trim_start: 19.24, raw_source: resolve(root, "uncut.webm"), proof: resolve(root, "receipt.json"), audio: "none", edits: "Setup, naming/selection pauses and save/reload wait omitted. Real actions remain chronological. No image generation, UI replacement, speed-up or frame interpolation.", shots }, null, 2));
console.log(JSON.stringify({ output, duration: frame / 25, shots: shots.length }));
