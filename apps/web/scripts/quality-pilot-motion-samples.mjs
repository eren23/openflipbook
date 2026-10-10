/** Offline decoded-frame evidence. No providers, HTTP, approvals or manifest writes. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { tsImport } from "tsx/esm/api";

const run = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const limits = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" };
const finite = value => typeof value === "number" && Number.isFinite(value);
let comparisonModule;
const comparison = () => comparisonModule ??= tsImport("../lib/motion-comparison.ts", import.meta.url);

export function decodedPilotMotionFrames(probe) {
  const videos = probe.streams?.filter(stream => stream.codec_type === "video") ?? [], video = videos[0];
  const duration = Number(video?.duration ?? probe.format?.duration), width = video?.width, height = video?.height;
  assert.ok(probe.format?.format_name?.split(",").includes("mp4") && videos.length === 1 && video.codec_name === "h264",
    "Samples require the saved H264 MP4 playback derivative");
  assert.ok(Number.isInteger(width) && Number.isInteger(height) && width >= 32 && height >= 32
    && width <= 4096 && height <= 4096 && width * height <= 8_400_000 && finite(duration) && duration > 0 && duration <= 20,
    "Unsupported decoded video size or duration");
  assert.equal(probe.streams.filter(stream => stream.codec_type === "audio").length, 0, "Use the saved silent derivative");
  // Refuse an ambiguous timeline rather than silently inventing a browser time
  // offset. The product's MP4 derivatives normally begin at zero.
  assert.ok(Math.abs(Number(video.start_time ?? 0)) <= .001 && Math.abs(Number(probe.format.start_time ?? 0)) <= .001,
    "Nonzero media origin needs separate timeline inspection");
  const frames = (probe.frames ?? []).filter(frame => frame.media_type === "video")
    .map((frame, index) => ({ index, seconds: Number(frame.best_effort_timestamp_time) }));
  assert.ok(frames.length >= 2 && frames.length <= 10_000 && frames.every((frame, index) =>
    finite(frame.seconds) && frame.seconds >= 0 && frame.seconds <= duration && (!index || frame.seconds >= frames[index - 1].seconds)),
    "Complete ordered decoded frame timestamps are required");
  assert.ok(frames[0].seconds <= .001, "Decoded frames do not start at the media origin");
  return { media: { width, height, duration, audio_streams: 0 }, frames };
}

export async function choosePilotMotionSamples({ plan, media, frames }) {
  const { motionSampleSeconds, motionDurationMatches, MOTION_COMPARISON_VERSION, MOTION_COMPARISON_VERSION_V1 } = await comparison();
  assert.ok([MOTION_COMPARISON_VERSION, MOTION_COMPARISON_VERSION_V1].includes(plan.version), "Unknown frozen comparison version");
  assert.ok(finite(plan.duration) && plan.duration > 0 && plan.duration <= 20 && Array.isArray(plan.frames)
    && plan.frames.length >= 2 && plan.frames.length <= 256 && finite(plan.tolerances?.seek_seconds)
    && plan.tolerances.seek_seconds > 0 && plan.tolerances.seek_seconds <= .25, "Invalid frozen sample schedule");
  const samples = plan.frames.map((frame, index) => {
    assert.ok(finite(frame.seconds) && frame.seconds >= 0 && frame.seconds <= plan.duration, "Invalid frozen sample time");
    const requested = motionSampleSeconds(plan, frame.seconds, media.duration);
    const nearest = frames.reduce((best, value) => Math.abs(value.seconds - requested) < Math.abs(best.seconds - requested) ? value : best);
    assert.ok(Math.abs(nearest.seconds - requested) <= plan.tolerances.seek_seconds,
      `No decoded frame within the frozen seek tolerance at sample ${index + 1}`);
    return { frame: index, reference_seconds: frame.seconds, requested_video_seconds: requested,
      decoded_frame: nearest.index, observed_seconds: nearest.seconds, seek_error_seconds: Math.abs(nearest.seconds - requested) };
  });
  return { samples, duration_matches: motionDurationMatches(plan, media.duration),
    aspect_ratio_matches: Math.abs((media.width / media.height) / (plan.width / plan.height) - 1) <= plan.tolerances.aspect_ratio };
}

const ordinaryFile = async path => {
  assert.ok(isAbsolute(path), "Use explicit absolute local input paths");
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Input must be an ordinary local file"); return stat;
};
export async function extractPilotMotionSamples({ clip, library: libraryPath, assetId, expectedSha256, output }) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/, "Pin the original saved playback SHA256");
  assert.ok(typeof assetId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(assetId), "Invalid saved asset identity");
  assert.ok(isAbsolute(output), "Use an explicit new absolute artifact directory");
  const stat = await ordinaryFile(clip); assert.ok(stat.size > 0 && stat.size <= 150 * 1024 * 1024, "Video exceeds the saved clip bound");
  const libraryStat = await ordinaryFile(libraryPath); assert.ok(libraryStat.size <= 8 * 1024 * 1024, "Saved library is unexpectedly large");
  const clipBytes = await readFile(clip), libraryBytes = await readFile(libraryPath);
  assert.equal(hash(clipBytes), expectedSha256, "Local clip differs from its immutable receipt");
  const library = JSON.parse(libraryBytes.toString("utf8")), matches = library.assets?.filter(asset => asset.id === assetId);
  assert.equal(matches?.length, 1, "Exactly one saved output is required");
  const asset = matches[0], frozen = asset.comparison;
  assert.ok(frozen?.plan && hash(JSON.stringify(frozen.plan)) === frozen.sha256, "Frozen comparison changed");
  assert.ok(library.jobs?.some(job => job.status === "ready" && job.asset_id === assetId), "Saved output has no acknowledged ready job");
  await mkdir(output, { mode: 0o700 }); // Existing evidence is never overwritten.
  const pinnedClip = join(output, "source.mp4");
  await writeFile(pinnedClip, clipBytes, { mode: 0o600, flag: "wx" });
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov",
    "-show_streams", "-show_format", "-show_frames", "-of", "json", pinnedClip], limits);
  await writeFile(join(output, "ffprobe.json"), stdout, { mode: 0o600, flag: "wx" });
  const decoded = decodedPilotMotionFrames(JSON.parse(stdout));
  assert.equal(decoded.media.width, asset.media.width); assert.equal(decoded.media.height, asset.media.height);
  assert.equal(asset.media.audio_streams, 0); assert.ok(Math.abs(decoded.media.duration - asset.media.duration) <= .001,
    "Decoded duration differs from the saved product media receipt");
  const selection = await choosePilotMotionSamples({ plan: frozen.plan, ...decoded }), samples = [];
  for (const sample of selection.samples) {
    const file = `sample-${String(sample.frame).padStart(2, "0")}.png`, target = join(output, file);
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", pinnedClip,
      "-map", "0:v:0", "-vf", `select=eq(n\\,${sample.decoded_frame})`, "-frames:v", "1", "-fps_mode", "passthrough", "-update", "1", "-n", target], limits);
    const bytes = await readFile(target);
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Decoded sample is not PNG");
    assert.equal(bytes.readUInt32BE(16), decoded.media.width); assert.equal(bytes.readUInt32BE(20), decoded.media.height);
    samples.push({ ...sample, file, sha256: hash(bytes), bytes: bytes.length });
  }
  const receipt = { version: 1, method: "Local decoded video frames selected by presentation timestamp; no observed boxes synthesized",
    asset_id: assetId, clip: { input: clip, file: "source.mp4", sha256: expectedSha256, bytes: clipBytes.length },
    library: { input: libraryPath, sha256: hash(libraryBytes) }, comparison_sha256: frozen.sha256,
    media: decoded.media, duration_matches: selection.duration_matches, aspect_ratio_matches: selection.aspect_ratio_matches,
    landmarks: frozen.plan.landmarks, tolerances: frozen.plan.tolerances, samples,
    expected_geometry: frozen.plan.frames, observed_bounds: "Not measured. Expected geometry must not be copied into observations.",
    provider_submissions: 0, created_at: new Date().toISOString() };
  await writeFile(join(output, "samples.json"), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { clip: { type: "string" }, library: { type: "string" }, asset: { type: "string" },
    sha256: { type: "string" }, output: { type: "string" } } });
  for (const key of ["clip", "library", "asset", "sha256", "output"]) assert.ok(values[key], `--${key} is required`);
  const receipt = await extractPilotMotionSamples({ clip: values.clip, library: values.library, assetId: values.asset,
    expectedSha256: values.sha256, output: values.output });
  console.log(JSON.stringify({ output: values.output, asset_id: receipt.asset_id, samples: receipt.samples.length,
    duration_matches: receipt.duration_matches, aspect_ratio_matches: receipt.aspect_ratio_matches, provider_submissions: 0 }));
}
