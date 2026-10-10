import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { choosePilotMotionSamples, decodedPilotMotionFrames, extractPilotMotionSamples } from "./quality-pilot-motion-samples.mjs";

const run = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const plan = () => ({ version: "visible-bounds-human-v2", provenance: "client_geometry_masks_human_video_bounds",
  width: 64, height: 48, duration: 1, issues: [], landmarks: [{ id: "test-landmark", label: "Synthetic test marker" }],
  tolerances: { position: .03, relative_size: .2, direction_cosine: .7, motion_signal: .015, seek_seconds: .1, duration_ratio: .15, aspect_ratio: .01 },
  frames: [0, .25, .5, .75, 1].map(seconds => ({ seconds, bounds: [[.2, .2, .4, .4]] })) });
const probe = () => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.1", start_time: "0.000000" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 64, height: 48, duration: "1.1", start_time: "0.000000" }],
  frames: Array.from({ length: 22 }, (_, i) => ({ media_type: "video", best_effort_timestamp_time: String(i / 20) })) });

test("uses the frozen product timing version and records the real decoded presentation time", async () => {
  const decoded = decodedPilotMotionFrames(probe()), frozen = plan();
  const v2 = await choosePilotMotionSamples({ plan: frozen, ...decoded });
  assert.equal(v2.samples[1].requested_video_seconds, .275);
  assert.ok(Math.abs(v2.samples[1].observed_seconds - .275) > .001, "Actual decoded timestamp must not be invented from the request");
  assert.equal(v2.samples.at(-1).observed_seconds, 1.05); assert.equal(v2.duration_matches, true);
  frozen.version = "visible-bounds-human-v1"; frozen.tolerances.duration_seconds = .25;
  assert.equal((await choosePilotMotionSamples({ plan: frozen, ...decoded })).samples[1].requested_video_seconds, .25);
  decoded.media.duration = 1.4; frozen.version = "visible-bounds-human-v2";
  // A failed duration still needs actual inspection if decoded samples exist.
  decoded.frames.push({ index: 22, seconds: 1.35 });
  assert.equal((await choosePilotMotionSamples({ plan: frozen, ...decoded })).duration_matches, false);
});
test("refuses an ambiguous origin, missing timestamps, audio, invalid media and unsupported comparison version", async () => {
  for (const alter of [value => value.streams.push({ codec_type: "audio" }), value => value.streams[0].start_time = "1",
    value => delete value.frames[2].best_effort_timestamp_time, value => value.frames[1].best_effort_timestamp_time = "-1",
    value => value.streams[0].duration = "21", value => value.streams[0].codec_name = "hevc"]) {
    const value = probe(); alter(value); assert.throws(() => decodedPilotMotionFrames(value));
  }
  const frozen = plan(); frozen.version = "invented";
  await assert.rejects(choosePilotMotionSamples({ plan: frozen, ...decodedPilotMotionFrames(probe()) }), /Unknown frozen/);
  const gap = decodedPilotMotionFrames(probe()); gap.frames = [gap.frames[0], gap.frames.at(-1)];
  await assert.rejects(choosePilotMotionSamples({ plan: plan(), ...gap }), /No decoded frame/);
});
test("extracts exact local decoded PNG samples while preserving source receipts and leaving observations unmeasured", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-motion-samples-")); t.after(() => rm(directory, { recursive: true }));
  const clip = join(directory, "clip.mp4"), libraryPath = join(directory, "library.json"), output = join(directory, "samples");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=20:duration=1.1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", clip], { timeout: 30_000 });
  const clipBytes = await readFile(clip), frozen = plan(), expectedSha256 = hash(clipBytes), library = {
    jobs: [{ id: "synthetic-job", asset_id: "synthetic-clip", status: "ready" }], assets: [{ id: "synthetic-clip",
      media: { width: 64, height: 48, duration: 1.1, audio_streams: 0 }, comparison: { plan: frozen, sha256: hash(JSON.stringify(frozen)) } }] };
  await writeFile(libraryPath, JSON.stringify(library)); const originalLibrary = await readFile(libraryPath);
  const receipt = await extractPilotMotionSamples({ clip, library: libraryPath, assetId: "synthetic-clip", expectedSha256, output });
  assert.equal(receipt.samples.length, 5); assert.equal(receipt.provider_submissions, 0);
  assert.equal(receipt.samples.at(-1).observed_seconds, 1.05); assert.equal(receipt.duration_matches, true);
  assert.match(receipt.observed_bounds, /Not measured/); assert.equal(receipt.observations, undefined);
  assert.equal(hash(await readFile(clip)), expectedSha256); assert.deepEqual(await readFile(libraryPath), originalLibrary);
  assert.equal(hash(await readFile(join(output, "source.mp4"))), expectedSha256);
  for (const sample of receipt.samples) assert.equal(hash(await readFile(join(output, sample.file))), sample.sha256);
  assert.ok(new Set(receipt.samples.map(sample => sample.sha256)).size >= 4, "Synthetic video must produce distinct actual frames");
  assert.equal((await readdir(output)).filter(file => file.endsWith(".png")).length, 5);
  assert.deepEqual(JSON.parse(await readFile(join(output, "samples.json"), "utf8")), receipt);
  await assert.rejects(extractPilotMotionSamples({ clip, library: libraryPath, assetId: "synthetic-clip", expectedSha256, output }), /EEXIST/);
  const changed = { ...library, assets: structuredClone(library.assets) }; changed.assets[0].comparison.plan.width++;
  await writeFile(libraryPath, JSON.stringify(changed));
  await assert.rejects(extractPilotMotionSamples({ clip, library: libraryPath, assetId: "synthetic-clip", expectedSha256, output: join(directory, "changed") }), /comparison changed/);
  await assert.rejects(extractPilotMotionSamples({ clip, library: libraryPath, assetId: "synthetic-clip", expectedSha256: "0".repeat(64), output: join(directory, "wrong") }), /immutable receipt/);
  assert.equal((await readdir(directory)).some(file => ["wrong", "changed"].includes(file)), false, "Failed binding creates no sample artifacts");
});
