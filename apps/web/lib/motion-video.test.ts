// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { motionVideoToolsAvailable, silentMotionVideo, inspectMotionArchiveVideos, legMotion, motionEnd, landCheck, cutLeg, joinLegs, grayFrame, FREEZE_DELTA, LAND_MAX, SNAP_MAX, MAX_MOTION_SECONDS, MAX_PATH_VIDEO_SECONDS } from "./motion-video";
// These tests run real ffmpeg or sharp. Several take 1 to 3.4 s on Linux, and in a gVisor
// sandbox or with two sandboxes on one host they pass the 5 s vitest default. So every test
// in this file gets 20 s, from the describe below. vi.setConfig would not hold: with vitest
// isolation off it only applies in the first test file that a worker runs.
const run = promisify(execFile), available = await motionVideoToolsAvailable();
let directory: string, source: string, bytes: Buffer;
beforeAll(async () => {
  if (!available) return;
  directory = await mkdtemp(join(tmpdir(), "ofb-motion-test-")); source = join(directory, "source.mp4");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
  bytes = await readFile(source);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
describe("motion video", { timeout: 20_000 }, () => {
  it.skipIf(!available)("removes audio while preserving the encoded video stream and original bytes", async () => {
    const original = Buffer.from(bytes), result = await silentMotionVideo(bytes), output = join(directory, "result.mp4");
    await writeFile(output, result.bytes);
    expect(bytes).toEqual(original);
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(result.hashes).toEqual({ original_sha256: hash(original), playback_sha256: hash(result.bytes) });
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
  it("ends motion at the last sustained run and ignores blips and encoder spikes after it", () => {
    // Shape of a real H3 leg: an ease-out, then isolated blips and a periodic spike.
    const deltas = [2, 3, 4, 2, 1, .5, .31, .1, .04, .59, .26, .06, .1, 2.5, .1, .05];
    expect(FREEZE_DELTA).toBe(.3);
    expect(motionEnd(deltas, 24)).toBe(8 / 24);
    expect(motionEnd([...deltas, .4, .5, .6], 24)).toBe(20 / 24);
    expect(motionEnd([.1, 5, 5, .1, .2], 10)).toBe(0);
    expect(motionEnd([], 24)).toBe(0);
    expect(motionEnd(deltas, 24, 3)).toBe(0);
    expect(motionEnd(deltas, 24, 1)).toBe(6 / 24);
  });
  it("lands only near the next keyframe and without a snap", () => {
    const frame = (value: number) => new Uint8Array(64 * 36).fill(value), smooth = [1, 2, 1, 1.5];
    expect(LAND_MAX).toBe(.35); expect(SNAP_MAX).toBe(8);
    expect(landCheck({ cutFrame: frame(100), nextKeyframe: frame(100), prevKeyframe: frame(60), deltasBeforeCut: smooth })).toEqual({ land: 0, snap: 2 / 1.25, ok: true });
    expect(landCheck({ cutFrame: frame(80), nextKeyframe: frame(100), prevKeyframe: frame(60), deltasBeforeCut: smooth })).toMatchObject({ land: .5, ok: false });
    expect(landCheck({ cutFrame: frame(100), nextKeyframe: frame(100), prevKeyframe: frame(60), deltasBeforeCut: [1, 1, 1, 9] })).toMatchObject({ snap: 9, ok: false });
    // Identical keyframes cannot hide an off-target landing behind a zero denominator.
    expect(landCheck({ cutFrame: frame(101), nextKeyframe: frame(100), prevKeyframe: frame(100), deltasBeforeCut: smooth })).toMatchObject({ land: 1, ok: false });
    expect(() => landCheck({ cutFrame: frame(1).subarray(1), nextKeyframe: frame(1), prevKeyframe: frame(1), deltasBeforeCut: [] })).toThrow();
  });
  describe.skipIf(!available)("leg video helpers", () => {
    let padded: Buffer;
    beforeAll(async () => {
      // One second of motion, then one second frozen on the last frame.
      const path = join(directory, "padded.mp4");
      await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2",
        "-vf", "tpad=stop_mode=clone:stop_duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path]);
      await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-frames:v", "1", join(directory, "frame.png")]);
      padded = await readFile(path);
    });
    it("measures the frozen tail of a clip", async () => {
      const motion = await legMotion(padded);
      expect(motion.fps).toBeCloseTo(12, 6);
      expect(motion.frames).toHaveLength(24); expect(motion.deltas).toHaveLength(23);
      expect(motion.frames[0]).toHaveLength(64 * 36);
      expect(Math.abs(motionEnd(motion.deltas, motion.fps) - 1)).toBeLessThanOrEqual(1 / 12 + 1e-9);
      // A still keyframe goes through the same 64x36 grey reduction as the clip.
      const still = await grayFrame(await readFile(join(directory, "frame.png")));
      expect(still).toHaveLength(64 * 36);
      expect(still.reduce((sum, v, i) => sum + Math.abs(v - motion.frames[0]![i]!), 0) / still.length).toBeLessThan(2);
    });
    it("trims, retimes and joins legs without audio", async () => {
      const slow = await cutLeg(padded, 1, 1.5), clamped = await cutLeg(padded, 1, 5), small = await cutLeg(padded, 1, 1, { width: 64, height: 48 });
      const media = async (bytes: Buffer) => (await silentMotionVideo(bytes)).media;
      expect(Math.abs((await media(slow)).duration - 1.5)).toBeLessThanOrEqual(1 / 24 + 1e-6);
      expect(Math.abs((await media(clamped)).duration - 2)).toBeLessThanOrEqual(1 / 24 + 1e-6);
      // The trim drops the frozen second.
      expect(await media(small)).toMatchObject({ width: 64, height: 48, source_audio_streams: 0 });
      expect(Math.abs((await media(small)).duration - 1)).toBeLessThanOrEqual(1 / 24 + 1e-6);
      const joined = await joinLegs([slow, clamped]);
      expect(joined.media).toMatchObject({ width: 128, height: 96, audio_streams: 0 });
      expect(Math.abs(joined.media.duration - 3.5)).toBeLessThanOrEqual(2 / 24 + 1e-6);
      await expect(cutLeg(padded, NaN, 1)).rejects.toThrow();
      await expect(cutLeg(padded, 1, 1, { width: 63, height: 48 })).rejects.toThrow();
      await expect(joinLegs([])).rejects.toThrow();
      await expect(cutLeg(padded, 4, 1)).rejects.toThrow("source duration");
      await expect(joinLegs([slow, small])).rejects.toThrow("differ in size");
      await expect(joinLegs([padded])).rejects.toThrow("contain audio");
    }, 30_000);

    it("assembles a real 24-second walk while keeping provider clips capped at 20 seconds", async () => {
      const clip = join(directory, "long-walk-leg.mp4");
      await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x32:rate=24:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      const raw = await readFile(clip), original = Buffer.from(raw), leg = await cutLeg(raw, 3, 1);
      const result = await joinLegs(Array(8).fill(leg), 24);
      expect(result.media.duration).toBeCloseTo(24, 1); expect(result.media.audio_streams).toBe(0);
      expect(raw).toEqual(original);
      expect(result.hashes.playback_sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
      await expect(silentMotionVideo(result.bytes)).rejects.toThrow("duration");
      await expect(joinLegs(Array(8).fill(leg), 12)).rejects.toThrow("differs from its plan");
    });

    it("accepts the assembled path limit and rejects longer or invalid plans before assembly", async () => {
      expect(MAX_MOTION_SECONDS).toBe(20); expect(MAX_PATH_VIDEO_SECONDS).toBe(60);
      const clip = join(directory, "ten-second-leg.mp4");
      await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x32:rate=24:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      const leg = await readFile(clip);
      expect((await joinLegs(Array(6).fill(leg), 60)).media.duration).toBeCloseTo(60, 1);
      await expect(joinLegs(Array(7).fill(leg))).rejects.toThrow("duration differs");
      for (const seconds of [NaN, 0, -1, 61]) await expect(joinLegs([leg], seconds)).rejects.toThrow("limit");
      await expect(joinLegs(Array(12).fill(leg))).rejects.toThrow("leg limit");
    });
  });
});
