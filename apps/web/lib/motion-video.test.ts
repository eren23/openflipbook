// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { motionVideoToolsAvailable, silentMotionVideo, inspectMotionArchiveVideos } from "./motion-video";
const run = promisify(execFile), available = await motionVideoToolsAvailable();
let directory: string, source: string, bytes: Buffer;
beforeAll(async () => {
  if (!available) return;
  directory = await mkdtemp(join(tmpdir(), "ofb-motion-test-")); source = join(directory, "source.mp4");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
  bytes = await readFile(source);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it.skipIf(!available)("removes audio while preserving the encoded video stream and original bytes", async () => {
  const original = Buffer.from(bytes), result = await silentMotionVideo(bytes), output = join(directory, "result.mp4");
  await writeFile(output, result.bytes);
  expect(bytes).toEqual(original);
  expect(result.media).toMatchObject({ width: 128, height: 96, duration: 1, audio_streams: 0, source_audio_streams: 1, derivative: "silent_streamcopy_v1" });
  const streamHash = async (path: string) => (await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])).stdout;
  expect(await streamHash(output)).toBe(await streamHash(source));
  const again = await silentMotionVideo(bytes); expect(again.bytes).toEqual(result.bytes);
});
it.skipIf(!available)("rejects invalid video bytes without producing a replayable derivative", async () => {
  await expect(silentMotionVideo(Buffer.from("not a video"))).rejects.toBeInstanceOf(Error);
  await expect(silentMotionVideo(Buffer.alloc(0))).rejects.toThrow("storage limit");
});
it.skipIf(!available)("verifies archived silent bytes without remuxing them and rejects audio-bearing playback", async () => {
  const result = await silentMotionVideo(bytes), unchanged = Buffer.from(result.bytes);
  expect(await inspectMotionArchiveVideos(bytes, result.bytes)).toEqual(result.media);
  expect(result.bytes).toEqual(unchanged);
  await expect(inspectMotionArchiveVideos(bytes, bytes)).rejects.toThrow("silent derivative");
});
it.skipIf(!available)("rejects an unrelated silent video even when its dimensions and duration match", async () => {
  const other = join(directory, "other.mp4");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=128x96:rate=12", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", other]);
  await expect(inspectMotionArchiveVideos(bytes, await readFile(other))).rejects.toThrow("different video stream");
});
