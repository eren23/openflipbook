import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export const MAX_MOTION_BYTES = 150 * 1024 * 1024;
const limits = { timeout: 90_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" as const };
export async function motionVideoToolsAvailable() {
  try { await run("ffmpeg", ["-version"], limits); await run("ffprobe", ["-version"], limits); return true; } catch { return false; }
}
interface Probe { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[] }
async function inspect(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-show_format", "-show_streams", "-of", "json", path], limits);
  const probe: Probe = JSON.parse(stdout), videos = probe.streams?.filter(s => s.codec_type === "video") ?? [];
  const video = videos[0], duration = Number(video?.duration ?? probe.format?.duration);
  if (!probe.format?.format_name?.split(",").includes("mp4") || videos.length !== 1 || video?.codec_name !== "h264"
    || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width! < 32 || video.height! < 32
    || video.width! > 4096 || video.height! > 4096 || video.width! * video.height! > 8_400_000
    || !Number.isFinite(duration) || duration <= 0 || duration > 20) throw new Error("Unsupported motion video format, size or duration");
  return { width: video.width!, height: video.height!, duration, audio_streams: probe.streams!.filter(s => s.codec_type === "audio").length };
}
// Validate an archived derivative without remuxing it: replay and review hashes
// must continue to identify the exact original saved bytes across hosts.
export async function inspectMotionArchiveVideos(original: Buffer, silent: Buffer) {
  if ([original, silent].some(bytes => !bytes.length || bytes.length > MAX_MOTION_BYTES)) throw new Error("Motion video exceeds its storage limit");
  const directory = await mkdtemp(join(tmpdir(), "ofb-motion-import-"));
  try {
    const source = join(directory, "source.mp4"), output = join(directory, "silent.mp4");
    await writeFile(source, original, { mode: 0o600 }); await writeFile(output, silent, { mode: 0o600 });
    const sourceInfo = await inspect(source), media = await inspect(output);
    if (media.audio_streams !== 0 || media.width !== sourceInfo.width || media.height !== sourceInfo.height || Math.abs(media.duration - sourceInfo.duration) > .1)
      throw new Error("Archived silent derivative differs from its source");
    const packetHash = async (path: string) => (await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", path,
      "-map", "0:v:0", "-c:v", "copy", "-f", "hash", "-hash", "sha256", "-"], limits)).stdout;
    if (await packetHash(source) !== await packetHash(output)) throw new Error("Archived derivative contains a different video stream");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", output,
      "-map", "0:v:0", "-f", "null", "-"], limits);
    return { ...media, source_audio_streams: sourceInfo.audio_streams, derivative: "silent_streamcopy_v1" as const };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function silentMotionVideo(original: Buffer) {
  if (!original.length || original.length > MAX_MOTION_BYTES) throw new Error("Motion video exceeds its storage limit");
  const directory = await mkdtemp(join(tmpdir(), "ofb-motion-")), source = join(directory, "source.mp4"), output = join(directory, "silent.mp4");
  try {
    await writeFile(source, original, { mode: 0o600 });
    const sourceInfo = await inspect(source);
    // Stream-copy preserves the encoded video. No audio, subtitles, chapters,
    // attachments or provider metadata enter the silent playback derivative.
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", source,
      "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-movflags", "+faststart", "-f", "mp4", output], limits);
    if ((await stat(output)).size > MAX_MOTION_BYTES) throw new Error("Silent video exceeds its storage limit");
    const media = await inspect(output);
    if (media.audio_streams !== 0 || media.width !== sourceInfo.width || media.height !== sourceInfo.height
      || Math.abs(media.duration - sourceInfo.duration) > .1) throw new Error("Silent derivative differs from its source");
    // A valid container can still contain corrupt frames. Decode every frame
    // without opening network protocols before making the clip replayable.
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", output,
      "-map", "0:v:0", "-f", "null", "-"], limits);
    return { bytes: await readFile(output), media: { ...media, source_audio_streams: sourceInfo.audio_streams, derivative: "silent_streamcopy_v1" as const } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Leg checks. Every frame and keyframe is reduced to 64x36 grey (0-255) by the
// same ffmpeg filter, so these thresholds keep their calibrated meaning.
// Set on the real H3 walk legs (route-video seg0-3, 2026-10-02):
// motion fades below 0.3 at 4.2-4.5 s of 5.17 s; good legs land at 0.11-0.18
// and snap at 2.5-4.7. All three stay tunable.
export const FREEZE_DELTA = .3;
// A frozen tail still has single-frame blips and encoder spikes about every
// 24 frames. Only a run of this many moving frames counts as motion.
export const MOTION_RUN = 3;
export const LAND_MAX = .35;
export const SNAP_MAX = 8;
export const LEG_FPS = 24;
const THUMB = ["-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"];
const thumbLimits = { ...limits, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" as const };
async function inTemp<T>(files: Record<string, Buffer>, work: (path: (name: string) => string) => Promise<T>) {
  if (Object.values(files).some(bytes => !bytes.length || bytes.length > MAX_MOTION_BYTES)) throw new Error("Motion video exceeds its storage limit");
  const directory = await mkdtemp(join(tmpdir(), "ofb-leg-")), path = (name: string) => join(directory, name);
  try {
    for (const [name, bytes] of Object.entries(files)) await writeFile(path(name), bytes, { mode: 0o600 });
    return await work(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const frames = (raw: Buffer) => Array.from({ length: Math.floor(raw.length / 2304) }, (_, i) => new Uint8Array(raw.subarray(i * 2304, (i + 1) * 2304)));
function mad(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length || !a.length) throw new Error("Frames differ in size");
  let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}
// One decode of the whole clip. deltas[i] is the mean grey change from frame i to i+1.
export async function legMotion(bytes: Buffer) {
  return inTemp({ "leg.mp4": bytes }, async path => {
    const media = await inspect(path("leg.mp4"));
    const { stdout } = await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", path("leg.mp4"), "-map", "0:v:0", ...THUMB], thumbLimits);
    const list = frames(stdout);
    if (list.length < 2) throw new Error("Motion video has too few frames");
    // Constant-rate clips only; a frame count over the stream length gives the rate.
    return { fps: list.length / media.duration, deltas: list.slice(1).map((frame, i) => mad(list[i]!, frame)), frames: list };
  });
}
// A still keyframe (PNG or JPEG) in the same 64x36 grey as legMotion frames.
export async function grayFrame(image: Buffer) {
  return inTemp({ image }, async path => {
    const { stdout } = await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "image2pipe", "-i", path("image"), "-frames:v", "1", ...THUMB], thumbLimits);
    const [frame] = frames(stdout);
    if (!frame) throw new Error("Keyframe image could not be decoded");
    return frame;
  });
}
// The time the last moving frame ends: a trim at this time keeps all motion.
export function motionEnd(deltas: readonly number[], fps: number, freezeDelta = FREEZE_DELTA) {
  let streak = 0, end = 0;
  for (const [i, delta] of deltas.entries()) {
    streak = delta >= freezeDelta ? streak + 1 : 0;
    if (streak >= MOTION_RUN) end = (i + 2) / fps;
  }
  return end;
}
// land: how far the cut frame is from the next keyframe, as a share of the
// keyframe-to-keyframe change. snap: the largest frame change over the median.
export function landCheck(input: { cutFrame: Uint8Array; nextKeyframe: Uint8Array; prevKeyframe: Uint8Array; deltasBeforeCut: readonly number[] }) {
  const land = mad(input.cutFrame, input.nextKeyframe) / Math.max(1, mad(input.prevKeyframe, input.nextKeyframe));
  const sorted = [...input.deltasBeforeCut].sort((a, b) => a - b), n = sorted.length;
  const snap = n ? sorted[n - 1]! / Math.max((sorted[(n - 1) >> 1]! + sorted[n >> 1]!) / 2, .01) : 0;
  return { land, snap, ok: land <= LAND_MAX && snap <= SNAP_MAX };
}
// Keep [0, endSeconds) and stretch it by factor (0.5-2). Re-encoded at a fixed
// rate and size so joinLegs can stream-copy the parts.
export async function cutLeg(bytes: Buffer, endSeconds: number, factor: number, scale?: { width: number; height: number }) {
  const valid = (n: number) => Number.isInteger(n) && n % 2 === 0 && n >= 32 && n <= 4096;
  if (!Number.isFinite(endSeconds) || endSeconds <= 0 || !Number.isFinite(factor) || scale && !(valid(scale.width) && valid(scale.height)))
    throw new Error("Invalid leg cut");
  const stretch = Math.min(2, Math.max(.5, factor));
  const filter = `trim=end=${endSeconds},setpts=(PTS-STARTPTS)*${stretch},fps=${LEG_FPS}${scale ? `,scale=${scale.width}:${scale.height}` : ""}`;
  return inTemp({ "leg.mp4": bytes }, async path => {
    await inspect(path("leg.mp4"));
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", path("leg.mp4"),
      "-map", "0:v:0", "-vf", filter, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-sn", "-dn", "-map_metadata", "-1",
      "-movflags", "+faststart", "-f", "mp4", path("cut.mp4")], limits);
    return readFile(path("cut.mp4"));
  });
}
// Concatenate cutLeg outputs without re-encoding, then validate the result as
// a silent playback video.
export async function joinLegs(legs: readonly Buffer[]) {
  if (!legs.length) throw new Error("No legs to join");
  const files = Object.fromEntries(legs.map((bytes, i) => [`leg${i}.mp4`, bytes]));
  const joined = await inTemp({ ...files, "list.txt": Buffer.from(legs.map((_, i) => `file 'leg${i}.mp4'\n`).join("")) }, async path => {
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "concat", "-i", path("list.txt"),
      "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", path("joined.mp4")], limits);
    return readFile(path("joined.mp4"));
  });
  return silentMotionVideo(joined);
}
