import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.resolve("next/package.json"));
const sharp = require("sharp");
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(web, "../../docs/research/assets/well-story-2026-09-11");
const work = resolve(root, "composition");
const output = resolve(process.argv[2] || `${root}/the-well-that-answers-back.mp4`);
mkdirSync(work, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
const page = name => resolve(root, "pages", name);
const map = page("001-Ankh-Morpork.jpg");
const street = page("002-The Mended Drum.jpg");
const tavern = page("005-Inside The Mended Drum Tavern.jpg");
const workshop = page("010-Craftsman Workshop by the Well.jpg");
const clue = resolve(root, "clue-insert.png");
const shots = [
  { name: "Title", image: map, duration: 4, z: [1, 1.025], focus: [.5, .5], title: true },
  { name: "The city", image: map, duration: 9, z: [1.025, 1.15], focus: [.452, .593], lines: ["In Ankh-Morpork, even the wells knew better", "than to offer anything for free."] },
  { name: "Filigree Street", image: street, duration: 5.6, z: [1, 1.055], focus: [.35, .68], lines: ["This one had started returning things."] },
  { name: "The well", image: street, duration: 4.4, z: [1.7, 1.85], focus: [0, 1], lines: ["A penny. A wedding ring."] },
  { name: "The key", image: clue, duration: 3.6, z: [1.8, 1.87], focus: [.7, .95], lines: ["Yesterday, a key."] },
  { name: "The Mended Drum", image: tavern, duration: 4.5, z: [1, 1.035], focus: [.4, .55], lines: ["The carpenter recognised it."] },
  { name: "The untouched drink", image: tavern, duration: 7, z: [1.4, 1.5], focus: [.42, .55], lines: ["He paid his bill, left his drink untouched,", "and went home before sunset."] },
  { name: "Across the street", image: street, duration: 3.2, z: [1.18, 1.25], focus: [0, .72] },
  { name: "The workshop", image: workshop, duration: 5.4, z: [1, 1.07], focus: [.35, .65], lines: ["On his workbench: a mechanism, and a note."] },
  { name: "The warning", image: clue, duration: 8.8, z: [1, 1.035], focus: [.35, .6], lines: ["If it knocks three times, wind it.", "If it knocks twice, leave town."] },
  { name: "Two knocks", image: workshop, duration: 6.6, z: [2, 2.07], focus: [.75, .62], knocks: [1.2, 2.5] },
  { name: "The empty room", image: workshop, duration: 5.8, z: [1.12, 1], focus: [.4, .65], lines: ["By morning, the carpenter's workshop was empty."] },
  { name: "The city remains", image: map, duration: 5, z: [1.15, 1], focus: [.452, .593] },
  { name: "One last knock", image: map, duration: 4.5, z: [1, 1], focus: [.5, .5], end: true, knocks: [1.2] },
];
const FPS = 30;
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? "pipe" : "inherit", encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.stderr || result.status}`);
  return result.stdout;
}
function ff(args) { return run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]); }
function duration(file) {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], true).trim());
}
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const timestamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace(".", ",");
let cursor = 0;
const captions = [];
for (const [index, shot] of shots.entries()) {
  if (!existsSync(shot.image)) throw new Error(`Missing story image: ${shot.image}`);
  if (shot.lines) {
    shot.voice = `${work}/voice-${index}.aiff`;
    const textFile = `${work}/voice-${index}.txt`;
    const speech = shot.lines.join(" ");
    const unchanged = existsSync(textFile) && readFileSync(textFile, "utf8") === speech;
    writeFileSync(textFile, speech);
    // Cache speech, not rendered shots, so re-framing does not regenerate narration.
    if (!unchanged || !existsSync(shot.voice)) run("say", ["-v", "Daniel", "-r", "145", "-f", textFile, "-o", shot.voice]);
    shot.speech_duration = duration(shot.voice);
    shot.duration = Math.max(shot.duration, shot.speech_duration + 1.15);
  }
  shot.frames = Math.ceil(shot.duration * FPS);
  shot.duration = shot.frames / FPS;
  shot.start = cursor;
  cursor += shot.duration;
  if (shot.lines) captions.push({ start: shot.start + .45, end: shot.start + shot.duration - .3, text: shot.lines.join("\n") });
  const normalized = `${work}/image-${index}.png`;
  await sharp(shot.image).resize(3840, 2160, { fit: "cover", position: "centre" }).png().toFile(normalized);
  const overlay = `${work}/overlay-${index}.png`;
  let lettering = "";
  if (shot.title || shot.end) {
    lettering = `<rect width="1920" height="1080" fill="#101311" opacity=".62"/>
      <text x="960" y="412" text-anchor="middle" font-family="Georgia" font-size="23" fill="#ddd9c7">${shot.end ? "A STORY FROM A WORLD IN OPENFLIPBOOK" : "AN ANKH-MORPORK TALE"}</text>
      <text x="960" y="505" text-anchor="middle" font-family="Georgia" font-size="72" fill="#faf5e8">The Well That</text>
      <text x="960" y="590" text-anchor="middle" font-family="Georgia" font-size="72" fill="#faf5e8">Answers Back</text>
      ${shot.end ? '<text x="960" y="740" text-anchor="middle" font-family="Arial" font-size="21" fill="#ddd9c7">An unofficial Discworld fan story</text>' : ""}`;
  } else if (shot.lines) {
    const top = shot.lines.length === 2 ? 924 : 968;
    lettering = `<rect x="180" y="${top - 42}" width="1560" height="${shot.lines.length * 49 + 23}" rx="3" fill="#101311" opacity=".8"/>`;
    lettering += shot.lines.map((line, row) => `<text x="960" y="${top + row * 49}" text-anchor="middle" font-family="Georgia" font-size="38" fill="#fffaf0">${escape(line)}</text>`).join("");
  }
  await sharp(Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">${lettering}</svg>`)).png().toFile(overlay);
  const progress = `(on/${shot.frames - 1})`;
  const easing = `(${progress}*${progress}*(3-2*${progress}))`;
  const zoom = `${shot.z[0]}+(${shot.z[1] - shot.z[0]})*${easing}`;
  const motion = `zoompan=z='${zoom}':x='(iw-iw/zoom)*${shot.focus[0]}':y='(ih-ih/zoom)*${shot.focus[1]}':d=${shot.frames}:s=1920x1080:fps=${FPS}`;
  const fade = index === 0 ? ",fade=t=in:d=0.6" : shot.end ? `,fade=t=out:st=${shot.duration - .85}:d=0.85` : "";
  ff(["-i", normalized, "-i", overlay, "-filter_complex", `[0:v]${motion},setsar=1[base];[base][1:v]overlay=0:0${fade}[v]`, "-map", "[v]", "-frames:v", String(shot.frames), "-an", "-c:v", "libx264", "-threads", "4", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-y", `${work}/shot-${index}.mp4`]);
  console.log(`Shot ${index + 1}/${shots.length}: ${shot.name} (${shot.duration.toFixed(2)}s)`);
}

// Original, deterministic sound design. Three physical knocks carry the ending;
// the very quiet tonal bed falls away before the two-knock reveal.
const rate = 48000;
const samples = Math.ceil(cursor * rate);
const pcm = Buffer.alloc(samples * 4);
let random = 731;
const noise = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2147483648 - 1; };
const reveal = shots.find(shot => shot.name === "Two knocks").start;
const knocks = shots.flatMap(shot => (shot.knocks || []).map(time => shot.start + time));
for (let i = 0; i < samples; i++) {
  const t = i / rate;
  const fade = Math.min(1, t / 3, Math.max(0, (reveal - t) / 2));
  const air = noise() * .0015;
  let sample = fade * (.006 * Math.sin(2 * Math.PI * 73.416 * t) + .003 * Math.sin(2 * Math.PI * 110 * t) + air);
  for (const hit of knocks) {
    for (const [delay, gain] of [[0, 1], [.17, .3], [.34, .12]]) {
      const dt = t - hit - delay;
      if (dt >= 0 && dt < .8) sample += gain * (.30 * Math.sin(2 * Math.PI * 145 * dt) * Math.exp(-dt * 24) + .12 * Math.sin(2 * Math.PI * 387 * dt) * Math.exp(-dt * 39) + .12 * noise() * Math.exp(-dt * 100));
    }
  }
  const value = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
  pcm.writeInt16LE(value, i * 4);
  pcm.writeInt16LE(value, i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
const sound = `${work}/sound-design.wav`;
writeFileSync(sound, Buffer.concat([header, pcm]));
writeFileSync(`${work}/concat.txt`, shots.map((_, i) => `file 'shot-${i}.mp4'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", `${work}/concat.txt`, "-c", "copy", "-y", `${work}/picture.mp4`]);
const inputs = ["-i", `${work}/picture.mp4`, "-i", sound];
const filters = [];
const labels = ["[1:a]"];
let inputIndex = 2;
for (const shot of shots.filter(shot => shot.voice)) {
  inputs.push("-i", shot.voice);
  const label = `voice${inputIndex}`;
  const delay = Math.round((shot.start + .45) * 1000);
  filters.push(`[${inputIndex}:a]aresample=48000,highpass=f=75,loudnorm=I=-19:TP=-3:LRA=7,adelay=${delay}:all=1[${label}]`);
  labels.push(`[${label}]`);
  inputIndex++;
}
filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,alimiter=limit=0.89:level=false,afade=t=out:st=${cursor - .6}:d=0.6[a]`);
ff([...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", String(cursor), "-movflags", "+faststart", "-metadata", "title=The Well That Answers Back", "-metadata", "comment=Illustrated fiction assembled from saved Openflipbook world images, one new generated clue insert, 2D image reframing, local synthetic narration, and original synthesized sound design. Not a continuous 3D capture. Unofficial Discworld fan story.", "-y", output]);
writeFileSync(resolve(root, "subtitles.srt"), captions.map((caption, i) => `${i + 1}\n${timestamp(caption.start)} --> ${timestamp(caption.end)}\n${caption.text}\n`).join("\n"));
writeFileSync(resolve(root, "film-receipt.json"), JSON.stringify({ output, duration_seconds: cursor, fps: FPS, resolution: [1920, 1080], voice: "macOS Daniel, synthetic, 145 words/minute", audio: "original deterministic synthesized bed and knocks; no licensed music", new_image_generation_calls: 1, new_video_generation_calls: 0, presentation: "Edited illustrated fiction; source-pixel pan/zoom with explicit location cuts, not reconstructed 3D movement", knocks, shots }, null, 2));
console.log(JSON.stringify({ output, duration_seconds: cursor, shots: shots.length, knocks }));
