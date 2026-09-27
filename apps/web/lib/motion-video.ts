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
