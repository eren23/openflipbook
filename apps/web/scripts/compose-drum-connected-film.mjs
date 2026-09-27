import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.resolve("next/package.json"));
const sharp = require("sharp");
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(web, "../../docs/research/assets");
const prior = resolve(assets, "ankh-image-first-take3");
const current = resolve(assets, "drum-connected-film-2026-09-11");
const output = resolve(process.argv[2] || `${current}/connected-film.mp4`);
const work = resolve(current, "composition");
mkdirSync(work, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
const read = path => JSON.parse(readFileSync(path, "utf8"));
const imageReceipt = read(`${prior}/receipt.json`);
const worldReceipt = read(`${current}/receipt.json`);
if (imageReceipt.status !== "complete" || imageReceipt.candidate?.mock !== false || imageReceipt.candidate?.outside_changed !== 0) {
  throw new Error("Completed, real, protected image-edit footage required");
}
if (worldReceipt.status !== "complete" || worldReceipt.errors.length || !worldReceipt.saved_world?.revision || worldReceipt.model_calls !== 0) {
  throw new Error("Verified save/reload recording without new model calls required");
}
const times = receipt => Object.fromEntries(receipt.events.map(event => [event.name, event.seconds]));
const i = times(imageReceipt);
const w = times(worldReceipt);
const imageVideo = `${prior}/image-first-uncut.webm`;
const worldVideo = `${current}/uncut.webm`;
const shots = [
  { file: imageVideo, start: i.map, end: i.environment - 0.06, crop: "1440:810:0:95", title: "The Mended Drum", detail: "ANKH-MORPORK / OPENFLIPBOOK" },
  { file: imageVideo, start: i.environment + 0.15, end: i.environment + 2.15, crop: "1440:810:0:95", title: "From the map, into Filigree Street", detail: "GENERATED STREET ILLUSTRATION" },
  { file: imageVideo, start: i.mask_drawn - 1.7, end: i.mask_drawn + 0.6, title: "Draw the change", detail: "NATIVE SKETCH / RECORDED IMAGE EDIT" },
  { file: imageVideo, start: i.generation_start - 0.7, end: i.generation_start + 0.6, title: "Change the roof. Protect the rest.", detail: "GENERATION WAIT REMOVED" },
  { file: imageVideo, start: Math.max(i.generation_complete + 2.2, i.edit_shown - 0.9), end: i.edit_shown + 2, title: "Review the image result", detail: "REAL MODEL OUTPUT / PROTECTED PIXELS UNCHANGED" },
  { file: resolve(web, "public/demos/ankh-morpork/street-edit.png"), still: true, duration: 1.8, title: "The saved illustration", detail: "THIS IMAGE BECOMES THE WORLD REFERENCE" },
  { file: worldVideo, start: w.textured + 0.2, end: w.second_view, crop: "1280:720:80:78", title: "Move through the 3D scene", detail: "AUTHORED GEOMETRY / APPROXIMATE IMAGE ALIGNMENT" },
  { file: worldVideo, start: w.roof_edit - 0.9, end: w.roof_edit + 1.4, title: "Match the roof in 3D", detail: "EXPLICIT MATERIAL EDIT / NOT AUTOMATIC TRANSFER" },
  { file: worldVideo, start: w.roof_edit + 2, end: w.return, crop: "1280:720:80:78", title: "Return through the same geometry", detail: "ONE PERSISTENT 3D SCENE" },
  { file: worldVideo, start: w.alignment + 0.2, end: w.alignment + 1.4, title: "Check the fit against the image", detail: "REFERENCE OVERLAY / RECONSTRUCTION STILL PROVISIONAL" },
  { file: worldVideo, start: w.world_draft + 0.1, end: w.world_saved + 0.6, title: "Preview. Apply. Save.", detail: "IMAGE REFERENCE + EDITABLE WORLD" },
  { file: worldVideo, start: w.world_reloaded + 0.2, end: w.connected_end - 0.1, title: "Reload. The world stays.", detail: "SAVED REVISION / OPENFLIPBOOK" },
];

function run(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.status}`);
}
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
let cursor = 0;
for (const [index, shot] of shots.entries()) {
  const duration = shot.duration ?? shot.end - shot.start;
  // Integer frame counts keep the receipt and hard-cut boundaries exact.
  shot.frames = Math.round(duration * 30);
  shot.film_start = cursor / 30;
  cursor += shot.frames;
  shot.film_end = cursor / 30;
  const overlay = `${work}/caption-${index}.png`;
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="960" width="1920" height="120" fill="#111b1a" fill-opacity="0.95"/><rect x="48" y="987" width="4" height="64" fill="#80bfa7"/><text x="72" y="1010" font-family="Arial" font-size="20" fill="#a7c4ba">${escape(shot.detail)}</text><text x="72" y="1051" font-family="Arial" font-size="32" font-weight="bold" fill="#ffffff">${escape(shot.title)}</text><text x="1860" y="1047" text-anchor="end" font-family="Arial" font-size="23" fill="#a7c4ba">${String(index + 1).padStart(2, "0")} / 12</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(overlay);
  const input = shot.still ? ["-loop", "1", "-framerate", "30", "-i", shot.file] : ["-ss", String(shot.start), "-i", shot.file];
  const framing = shot.crop
    ? `crop=${shot.crop},scale=1920:1080`
    : "scale=1920:960:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(960-ih)/2:color=0x111b1a";
  run([...input, "-i", overlay, "-filter_complex", `[0:v]${framing},fps=30,setsar=1[base];[base][1:v]overlay=0:0[out]`, "-map", "[out]", "-frames:v", String(shot.frames), "-an", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p", "-y", `${work}/shot-${index}.mp4`]);
  console.log(`Rendered ${index + 1}/${shots.length}: ${shot.title}`);
}
writeFileSync(`${work}/concat.txt`, shots.map((_, index) => `file 'shot-${index}.mp4'`).join("\n"));
run(["-f", "concat", "-safe", "0", "-i", `${work}/concat.txt`, "-c", "copy", "-movflags", "+faststart", "-metadata", "comment=Edited demonstration from two actual recorded sessions. Prior real image edit; current authored 3D geometry and live save/reload. Explicit image-to-3D cut; not an exact reconstruction or automatic material transfer. No new model calls.", "-y", output]);
writeFileSync(`${current}/film-receipt.json`, JSON.stringify({ output, duration_seconds: cursor / 30, model_calls_this_composition: 0, audio: "none", image_receipt: `${prior}/receipt.json`, world_receipt: `${current}/receipt.json`, shots }, null, 2));
console.log(JSON.stringify({ output, seconds: cursor / 30 }));
