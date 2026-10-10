import type { Document } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { archiveHash, archiveList, archiveObject, invalidArchive, type WorldArchive } from "./world-import-archive";
import { isSafeId } from "./ids";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import { illustrationDependency } from "./illustration-input";
import { assertPathReceiptSource, inertPathVideoReceipt, pathVideoReceipt } from "./path-video-archive";
import { MAX_MOTION_BYTES, MAX_PATH_VIDEO_SECONDS } from "./motion-video";
import type { MotionFile } from "./motion-job";
import type { MotionStudyDoc } from "./motion-study";
import type { PathVideoDoc } from "./path-video";
import type { WorldImportPlan } from "./world-import-plan";

const run = promisify(execFile), limits = { timeout: 90_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" as const };
const id = (value: unknown): string => isSafeId(value) ? value : invalidArchive("Invalid path video identity");
const text = (value: unknown, cap = 2000): string => typeof value === "string" && value.length <= cap ? value : invalidArchive("Invalid path video text");
const finite = (value: unknown, min = 0, max = 1e8): number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : invalidArchive("Invalid path video number");
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalidArchive("Invalid path video hash");

// Read-only local verification of the exact bundled MP4. No remuxing: the
// accepted video byte hash must survive transfer between installations.
export async function inspectArchivedPathVideo(bytes: Buffer, silent: boolean) {
  if (!bytes.length || bytes.length > MAX_MOTION_BYTES) invalidArchive("Path video exceeds its storage limit");
  const directory = await mkdtemp(join(tmpdir(), "ofb-path-import-"));
  try {
    const file = join(directory, "video.mp4"); await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-show_format", "-show_streams", "-of", "json", file], limits);
    const info = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[] };
    const videos = info.streams?.filter(stream => stream.codec_type === "video") ?? [], video = videos[0];
    const duration = Number(video?.duration ?? info.format?.duration), audio_streams = info.streams?.filter(stream => stream.codec_type === "audio").length ?? 0;
    if (!info.format?.format_name?.split(",").includes("mp4") || videos.length !== 1 || video?.codec_name !== "h264" || !Number.isInteger(video.width) || !Number.isInteger(video.height)
      || video.width! < 32 || video.height! < 32 || video.width! > 4096 || video.height! > 4096 || video.width! * video.height! > 8_400_000
      || !Number.isFinite(duration) || duration <= 0 || duration > MAX_PATH_VIDEO_SECONDS + .5 || silent && audio_streams !== 0) invalidArchive("Invalid archived path video encoding, dimensions or duration");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", file, "-map", "0:v:0", "-f", "null", "-"], limits);
    return { width: video!.width!, height: video!.height!, duration, audio_streams };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function importWorldPathVideos(archive: WorldArchive, sid: string, records: Record<string, Document[]>, uploads: WorldImportPlan["uploads"]) {
  if (!archive.files.has("path-videos.json")) { if (Number(archive.manifest.version) >= 4) invalidArchive("Path video archive metadata is missing"); return; }
  if (![4,5].includes(Number(archive.manifest.version))) invalidArchive("Path video content requires archive version 4");
  const content = archiveObject(archive.json("path-videos.json")); if (content.version !== 1) invalidArchive("Unsupported path video archive version");
  const sourceSid = id(archive.manifest.session_id), files = new Map<string, { bytes: Buffer; descriptor: MotionFile }>(), used = new Set<string>();
  for (const raw of archiveList(content.files, 15000).map(archiveObject)) {
    const key = text(raw.key), file = text(raw.file, 500), bytes = archive.files.get(file);
    if (files.has(key) || !file.startsWith("path-videos/") || !bytes || raw.bytes !== bytes.length || hash(raw.sha256) !== archiveHash(bytes)) invalidArchive("Missing, duplicate or corrupted path video file");
    files.set(key, { bytes: bytes!, descriptor: { key: `${sid}/restored/${raw.sha256}`, bytes: bytes!.length, sha256: String(raw.sha256) } });
  }
  function stored(raw: unknown, art = false) {
    const reference = archiveObject(raw), found = files.get(text(reference.key));
    if (!found || found.descriptor.sha256 !== reference.sha256 || !art && found.descriptor.bytes !== reference.bytes) invalidArchive("Path video file binding differs from its bytes");
    used.add(String(reference.key)); return found!;
  }
  function upload(file: { bytes: Buffer; descriptor: MotionFile }, contentType: string) {
    const previous = uploads.find(item => item.key === file.descriptor.key);
    if (previous) { if (!previous.bytes.equals(file.bytes) || previous.contentType !== contentType) invalidArchive("Conflicting restored path video file"); }
    else uploads.push({ key: file.descriptor.key, bytes: file.bytes, contentType });
  }
  const studies = archiveList(archiveObject(archive.json("motion.json")).studies).map(archiveObject) as unknown as MotionStudyDoc[];
  const views = (records.place_views ?? []) as PlaceViewDoc[], restored: PathVideoDoc[] = [], seen = new Set<string>(), perSource = new Map<string, number>();
  for (const raw of archiveList(content.receipts).map(archiveObject)) {
    const receiptId = id(raw.id), created = new Date(text(raw.created_at, 40)), originalSpend = archiveObject(raw.original_spend);
    if (seen.has(receiptId) || raw.session_id !== sourceSid || !Number.isFinite(created.getTime()) || !["ready", "needs_review", "failed", "cancelled"].includes(String(raw.status))) invalidArchive("Invalid or active path video receipt");
    if (["ledger_ids", "work_token", "work_until", "next_check", "verification_version", "resume_history"].some(field => field in raw)) invalidArchive("Path video receipt contains execution or attestation state");
    seen.add(receiptId); finite(originalSpend.reservation); finite(originalSpend.committed); text(raw.prompt, 1024); finite(raw.duration, .01, MAX_PATH_VIDEO_SECONDS); if (raw.subject !== null) text(raw.subject);
    const frames = archiveList(raw.keyframes, 12).map(archiveObject), legs = archiveList(raw.legs, 11).map(archiveObject);
    if (frames.length < 2 || legs.length !== frames.length - 1) invalidArchive("Path video checkpoint and leg inventory differs");
    for (const frame of frames) {
      finite(frame.frame, 0, 200); finite(frame.time, 0, 1); if (!["source", "first", "chain"].includes(String(frame.stage))) invalidArchive("Invalid path video keyframe stage");
      for (const variant of [frame, ...(frame.other ? [archiveObject(frame.other)] : [])]) {
        if (variant.attempt) validateAttempt(archiveObject(variant.attempt));
        if (variant.result) { const result = archiveObject(variant.result); if (!["passed", "failed", "unmeasured"].includes(String(result.gate)) || typeof result.passed !== "boolean") invalidArchive("Invalid saved keyframe evidence");
          if (result.final_image && variant.file && archiveObject(result.final_image).sha256 !== archiveObject(variant.file).sha256) invalidArchive("Final keyframe evidence identifies different bytes"); }
      }
    }
    for (const leg of legs) { finite(leg.seconds, .01, MAX_PATH_VIDEO_SECONDS); finite(leg.duration, 1, 15); finite(leg.cost); if (leg.chosen !== undefined) finite(leg.chosen, 0, 1);
      for (const attempt of archiveList(leg.attempts, 2).map(archiveObject)) validateAttempt(attempt); }
    if (raw.study_id) { id(raw.study_id); hash(raw.study_sha256); hash(raw.preparation_sha256); } else { id(raw.place_id); archiveList(raw.view_ids, 12).forEach(id); hash(raw.views_sha256); }
    if (raw.keyframe_policy !== undefined) {
      const route = raw.keyframe_policy === "accepted-route-v1";
      if (!(["accepted-only-v1", "accepted-route-v1"] as unknown[]).includes(raw.keyframe_policy) || raw.study_id || raw.retry_allowance !== 0) invalidArchive("Invalid accepted-anchor path policy");
      hash(raw.accepted_anchors_sha256);
      const anchors = archiveList(raw.accepted_anchors, route ? 12 : 2).map(archiveObject);
      if (route ? anchors.length < 2 || anchors.length !== frames.length : anchors.length !== 2) invalidArchive("Accepted video anchor inventory differs");
      for (const anchor of anchors) { id(anchor.view_id); id(anchor.asset_id); finite(anchor.bytes, 1, 4 * 1024 * 1024);
        for (const field of ["sha256", "input_sha256", "camera_sha256", "source_sha256", "review_sha256"]) hash(anchor[field]); }
    } else if (raw.accepted_anchors !== undefined || raw.accepted_anchors_sha256 !== undefined || raw.retry_allowance !== undefined) invalidArchive("Unbound accepted-only path metadata");
    if (raw.archive_provenance) { const provenance = archiveObject(raw.archive_provenance); if (provenance.version !== 1 || !["ready", "needs_review", "failed", "cancelled"].includes(String(provenance.original_status))) invalidArchive("Invalid archived path provenance");
      id(provenance.source_session_id); id(provenance.source_id); finite(provenance.committed); }
    const receipt = pathVideoReceipt({ ...raw, created_at: created, reservation: originalSpend.reservation, committed: originalSpend.committed } as unknown as PathVideoDoc);
    if (!receipt) invalidArchive("Path video receipt contains no completed work");
    assertPathReceiptSource(receipt!, studies, views);
    const group = receipt!.study_id ?? receipt!.place_id!, count = (perSource.get(group) ?? 0) + 1; perSource.set(group, count); if (count > 20) invalidArchive("Too many path videos for one saved source");
    const sourceView = receipt!.study_id ? views.find(view => view.id === studies.find(study => study.id === receipt!.study_id)!.view_id) : views.find(view => view.id === receipt!.view_ids![0]);
    if (!sourceView) invalidArchive("Path video source camera is unavailable");
    async function image(reference: unknown, art = false) {
      const file = stored(reference, art), decoder = sharp(file.bytes, { limitInputPixels: art ? 16 * 1024 * 1024 : 1024 * 1024, failOn: "warning" }), info = await decoder.metadata();
      if (!["png", "jpeg"].includes(info.format ?? "") || !art && receipt!.keyframe_policy === "accepted-route-v1" && info.format !== "jpeg" || (info.pages ?? 1) !== 1 || (info.orientation ?? 1) !== 1
        || (art ? file.bytes.length > 12 * 1024 * 1024 || !info.width || !info.height || info.width < 16 || info.height < 16 || info.width > 4096 || info.height > 4096
          : info.width !== sourceView!.width || info.height !== sourceView!.height)) invalidArchive("Path keyframe dimensions or encoding differ");
      await decoder.stats(); upload(file, `image/${info.format}`); return file.descriptor;
    }
    if (receipt!.art) { const file = await image(receipt!.art, true); receipt!.art = { key: file.key, sha256: file.sha256 }; }
    for (const frame of receipt!.keyframes) for (const variant of [frame, ...(frame.other ? [frame.other] : [])]) if (variant.file) variant.file = await image(variant.file);
    for (const leg of receipt!.legs) for (const attempt of leg.attempts) for (const name of ["original", "cut"] as const) if (attempt[name]) {
      const file = stored(attempt[name]); await inspectArchivedPathVideo(file.bytes, name === "cut"); upload(file, "video/mp4"); attempt[name] = file.descriptor;
    }
    if (receipt!.video) { const file = stored(receipt!.video), media = await inspectArchivedPathVideo(file.bytes, true);
      if (!receipt!.media || !isDeepStrictEqual(receipt!.media, { ...media, source_audio_streams: 0, derivative: "silent_streamcopy_v1" })) invalidArchive("Saved path video metadata differs from its bytes");
      upload(file, "video/mp4"); receipt!.video = file.descriptor;
    } else if (receipt!.status === "ready" || receipt!.media) invalidArchive("Ready path video media is missing");
    if (receipt!.study_id) receipt!.study_sha256 = viewHash(records.motion_studies!.find(study => study.id === receipt!.study_id));
    else receipt!.views_sha256 = viewHash(receipt!.view_ids!.map(viewId => illustrationDependency(views.find(view => view.id === viewId)!)));
    restored.push(inertPathVideoReceipt(receipt!, sid));
  }
  if (used.size !== files.size) invalidArchive("Archive contains unbound path video files");
  records.path_videos = restored;
}

function validateAttempt(attempt: Record<string, unknown>) {
  if ("token" in attempt || !["submitting", "submission_unknown", "queued", "running", "ready", "failed", "refused"].includes(String(attempt.status))) invalidArchive("Invalid archived attempt or execution claim");
  finite(attempt.cost); if (attempt.request_id !== undefined) text(attempt.request_id); if (attempt.prompt !== undefined) text(attempt.prompt, 20000);
  if (attempt.metrics) { const metrics = archiveObject(attempt.metrics); for (const field of ["end", "land", "snap", "factor"]) finite(metrics[field]); if (typeof metrics.ok !== "boolean") invalidArchive("Invalid path landing evidence"); }
}
