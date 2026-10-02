/**
 * Path videos: a keyframe painted at each checkpoint of a saved motion study,
 * then one H3 first/last-frame leg between each pair, trimmed, land-checked
 * and joined. The worker does one leased step per tick. Each paid step is
 * claimed on the document (its cost committed) before its one POST, so a lost
 * response stays submission_unknown and is never sent again.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db, Filter } from "mongodb";
import { MathUtils } from "three";
import { withDbTransaction } from "./db";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { assetBackend } from "./mesh-execution";
import { meshDownloadUrl } from "./mesh-asset";
import { download, verified } from "./motion-execution";
import { motionQuote } from "./motion-job-server";
import { currentMotionStudy } from "./motion-source";
import { fenceViewSources, viewHash } from "./place-view-store";
import { reserveGenerationSpend } from "./generation-reservation";
import { keyframeArt } from "./illustration-input";
import { finishKeyframe, keyframeGateBody, prepareKeyframeInput, type KeyframeChain, type KeyframePasses } from "./illustration-keyframe-server";
import { KEYFRAME_MODEL } from "./asset-pipeline";
import { H3_CAMERA_ADAPTER } from "./camera-motion";
import { sampleCameraPath, type CameraKeyframe, type OrbitPose } from "./camera-path";
import { cutLeg, grayFrame, joinLegs, landCheck, legMotion, motionEnd } from "./motion-video";
import { uploadJpeg } from "./r2";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionFile } from "./motion-job";
import type { KeyframeGateDoc } from "./mesh-docs";
import type { IllustrationKeyframe } from "./place-view";

export const PATH_VIDEO_CAP_USD = 10;
export const LEG_MODEL = "minimax/h3-max/image-to-video";
// Mirrors LEG_MOTION_SHARE and leg_seconds() in providers/video.py: H3 moves
// for about 0.8 of a clip, then holds. Change both together.
export const LEG_MOTION_SHARE = .8;
export const legSeconds = (planned: number) => Math.max(5, Math.min(15, Math.ceil(Number((planned / LEG_MOTION_SHARE).toFixed(6)))));

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
const height = (pose: OrbitPose) => pose.distance * Math.sin(MathUtils.degToRad(pose.elevation));
/**
 * The /motion/leg move between two path times. A positive orbit moves the
 * camera to its own right (azimuth grows from +Z toward +X, see orbitPosition).
 * rise is the change in height over the pivot; forward is how much closer to
 * the pivot the camera ends. The camera keeps facing the pivot, so no turn.
 */
export function legMove(keyframes: readonly CameraKeyframe[], from: number, to: number, subject: string | null) {
  const a = sampleCameraPath(keyframes, from), b = sampleCameraPath(keyframes, to);
  return { orbit_deg: round(clamp(b.azimuth - a.azimuth, 180)), turn_deg: 0, rise_m: round(clamp(height(b) - height(a), 500)),
    forward_m: round(clamp(a.distance - b.distance, 500)), subject };
}

type AttemptState = "submitting" | "submission_unknown" | "queued" | "running" | "ready" | "failed" | "refused";
interface Attempt { token: string; cost: number; status: AttemptState; request_id?: string }
export interface PathVideoKeyframe {
  frame: number; time: number; stage: "source" | "first" | "chain";
  attempt?: Attempt; gate_object_id?: string | null; gate?: KeyframeGateDoc; file?: MotionFile;
  result?: Pick<IllustrationKeyframe, "gate" | "candidates" | "chosen" | "passed" | "sky_pinned"> & { chain?: { angle: number; hole_share: number } };
}
export interface LegAttempt extends Attempt {
  prompt?: string; original?: MotionFile; cut?: MotionFile;
  metrics?: { end: number; land: number; snap: number; ok: boolean; factor: number };
}
export interface PathVideoLeg {
  seconds: number; duration: number; cost: number; move: ReturnType<typeof legMove>;
  attempts: LegAttempt[]; retry?: string; chosen?: number; landed?: boolean;
}
export type PathVideoState = "scheduled" | "running" | "submission_unknown" | "ready" | "failed" | "cancelled";
export interface PathVideoDoc {
  _id: string; id: string; session_id: string; study_id: string; study_sha256: string; preparation_sha256: string;
  request_sha256: string; created_at: Date; status: PathVideoState; prompt: string;
  reservation: number; committed: number; ledger_ids: string[];
  keyframe_reservation: number; keyframe_parameters: Record<string, unknown>; art: { key: string; sha256: string } | null;
  duration: number; subject: string | null; keyframes: PathVideoKeyframe[]; legs: PathVideoLeg[];
  video?: MotionFile; media?: MotionAssetDoc["media"];
  error?: string; errors?: number; work_token?: string; work_until?: Date; next_check?: Date;
}
const ACTIVE: PathVideoState[] = ["scheduled", "running", "submission_unknown"];

/** Checkpoint keyframes and legs of a study; throws 409 when a study cannot make a path video. */
export function pathVideoPlan(study: MotionStudyDoc) {
  const prep = study.preparation, checkpoints = prep.checkpoints ?? [];
  if (prep.adapter !== H3_CAMERA_ADAPTER || checkpoints.length < 2) throw new CreatorError("This study has no path checkpoints. Save a new motion study.", 409);
  if (study.client_preflight?.status !== "clear") throw new CreatorError("Save a study with a clear local path check", 409);
  // Depth ranges differ per camera, and the keyframe warp needs each one.
  if (checkpoints.some(i => !study.frames[i]?.depth || !study.files[i])) throw new CreatorError("This study has no per-frame depth ranges. Save a new motion study.", 409);
  const subject = study.source.definitions.flatMap(s => s.definition.objects).find(o => o.id === prep.path.target_id)?.label.slice(0, 120) ?? null;
  const times = checkpoints.map(i => study.frames[i]!.time);
  return { subject, duration: prep.path.duration,
    keyframes: checkpoints.map((frame, i): PathVideoKeyframe => ({ frame, time: times[i]!, stage: i ? "chain" : study.source.image.asset_id ? "source" : "first" })),
    legs: times.slice(1).map((to, i) => {
      const seconds = round(prep.path.duration * (to - times[i]!), 3);
      return { seconds, duration: legSeconds(seconds), move: legMove(prep.path.keyframes, times[i]!, to, subject) };
    }) };
}
async function pathVideoQuote(db: Db, plan: ReturnType<typeof pathVideoPlan>) {
  const config = await assetBackend("illustration", "keyframe-capabilities");
  if (!config?.enabled || config.model !== KEYFRAME_MODEL || !Number.isFinite(config.reservation) || config.reservation <= 0 || !config.parameters)
    throw new CreatorError("Keyframe painting is not configured", 503);
  const costs = new Map<number, number>();
  for (const { duration } of plan.legs) if (!costs.has(duration)) costs.set(duration, (await motionQuote(db, duration)).reservation);
  if (!await db.collection("generation_workers").findOne({ kind: "place-layout", path_video_v1: true, last_seen: { $gt: new Date(Date.now() - 30_000) } }))
    throw new CreatorError("Compatible path video worker unavailable", 503);
  const micros = (n: number) => Math.round(n * 1_000_000), paid = plan.keyframes.filter(k => k.stage !== "source").length;
  const reservation = (paid * micros(config.reservation) + plan.legs.reduce((sum, leg) => sum + micros(costs.get(leg.duration)!), 0)) / 1_000_000;
  if (reservation > PATH_VIDEO_CAP_USD) throw new CreatorError(`This path video needs $${reservation.toFixed(2)}, over the $${PATH_VIDEO_CAP_USD} cap. Shorten the path.`, 409);
  return { reservation, paid_keyframes: paid, keyframe_reservation: config.reservation as number, keyframe_parameters: config.parameters as Record<string, unknown>,
    legs: plan.legs.map(leg => ({ seconds: leg.seconds, duration: leg.duration, reservation: costs.get(leg.duration)! })) };
}

// Release the unspent part of the reservation and close the job, once.
async function settle(db: Db, guard: Filter<PathVideoDoc>, status: "ready" | "failed" | "cancelled", set: Partial<PathVideoDoc>) {
  return withDbTransaction(async (db, session) => {
    const col = db.collection<PathVideoDoc>("path_videos"), options = { session };
    const job = await col.findOne(guard, options);
    if (!job) return false;
    const unspent = round(job.reservation - job.committed, 6);
    if (unspent > 0) for (const id of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -unspent } }, options);
    await col.updateOne({ _id: job._id }, { $set: { status, ...set } }, options);
    return true;
  });
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function stored(file?: { key: string; sha256: string; bytes?: number }) {
  const bytes = await verified(file);
  if (!bytes) throw new Error("Saved path video input bytes are unavailable");
  return bytes;
}
// A refusal our backend makes before any provider POST: nothing was billed.
const refused = (e: unknown) => [400, 409, 422, 503].includes((e as { status?: number } | null)?.status ?? 0);
const frameView = (study: MotionStudyDoc, frame: number) =>
  ({ ...study.source.view, camera: study.frames[frame]!.camera, depth: { ...study.source.view.depth, ...study.frames[frame]!.depth! } });
async function framePasses(study: MotionStudyDoc, frame: number): Promise<KeyframePasses> {
  const files = study.files[frame]!, [render, depth, objects] = await Promise.all([stored(files.render), stored(files.depth), stored(files.objects)]);
  return { view: frameView(study, frame), render, depth, objects };
}

// One step of one job. Returns how long to wait before its next step.
async function step(db: Db, job: PathVideoDoc, token: string): Promise<number> {
  const col = db.collection<PathVideoDoc>("path_videos"), lease = { _id: job._id, work_token: token }, live = { ...lease, status: "running" as const };
  const save = async (set: Partial<PathVideoDoc>) => { if (!(await col.updateOne(live, { $set: set })).matchedCount) throw new Error("Path video lease lost"); };
  const fail = async (error: string) => { await settle(db, live, "failed", { error }); return 0; };
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${job.session_id}:${job.study_id}`, session_id: job.session_id });
  if (!study || viewHash(study) !== job.study_sha256) return fail("The motion study changed. Unspent reservation released.");
  const file = (name: string, ext: string, bytes: Buffer): MotionFile => ({ key: `${job.session_id}/path-videos/${job.id}/${name}-${hash(bytes)}.${ext}`, sha256: hash(bytes), bytes: bytes.length });
  const halt = async (attempt: Attempt, arrays: () => Partial<PathVideoDoc>) => {
    attempt.status = "submission_unknown";
    await col.updateOne(lease, { $set: arrays() });
    await col.updateOne(live, { $set: { status: "submission_unknown", error: "A paid response was lost. It may be billable; nothing is sent again. Cancel to release the rest." } });
    return 0;
  };
  // Claim (cost committed) -> one POST -> request id.
  const post = async (attempt: Attempt, arrays: () => Partial<PathVideoDoc>, model: string, send: () => Promise<Record<string, unknown>>) => {
    if (!(await col.updateOne({ ...live, work_until: { $gt: new Date(Date.now() + 120_000) } }, { $set: arrays(), $inc: { committed: attempt.cost } })).matchedCount) return 0;
    let receipt: Record<string, unknown> | undefined;
    try { receipt = await send(); }
    catch (e) {
      if (!refused(e)) return halt(attempt, arrays);
      attempt.status = "refused";
      await col.updateOne(live, { $set: arrays(), $inc: { committed: -attempt.cost } });
      return fail("The backend refused a paid step before sending it. Unspent reservation released.");
    }
    if (!isSafeId(receipt?.request_id) || receipt.request_id.length > 100 || receipt.model !== model) return halt(attempt, arrays);
    // A late id is kept even if the job was cancelled meanwhile.
    Object.assign(attempt, { status: "queued", request_id: receipt.request_id, ...(typeof receipt.prompt === "string" ? { prompt: receipt.prompt.slice(0, 2000) } : {}) });
    await col.updateOne(lease, { $set: arrays() });
    return 5000;
  };
  const poll = async (attempt: Attempt, arrays: () => Partial<PathVideoDoc>, path: string, kind: "illustration" | "motion") => {
    const result = await assetBackend(kind, path);
    if (result?.status === "queued" || result?.status === "running") { attempt.status = result.status; await save(arrays()); return 5000; }
    if (result?.status === "failed") { attempt.status = "failed"; await save(arrays()); return fail("The provider rejected a paid step. Unspent reservation released."); }
    if (result?.status !== "ready") throw new Error("Unknown provider state");
    return result as Record<string, unknown>;
  };

  const k = job.keyframes.findIndex(kf => !kf.file);
  if (k >= 0) {
    const kf = job.keyframes[k]!, arrays = () => ({ keyframes: job.keyframes });
    if (kf.stage === "source") {
      // The accepted study source image is keyframe 0; nothing is painted.
      const { key, sha256, bytes } = study.source.image;
      await stored({ key, sha256, bytes });
      kf.file = { key, sha256, bytes }; await save(arrays()); return 0;
    }
    const prev = job.keyframes[k - 1], attempt = kf.attempt;
    // Keyframe i is chained from keyframe i-1 (its camera, depth pass and image).
    const captures = async () => ({ passes: await framePasses(study, kf.frame), chain: prev ? { view: frameView(study, prev.frame),
      depth: await stored(study.files[prev.frame]!.depth), image: await stored(prev.file) } as KeyframeChain : undefined });
    if (!attempt) {
      const { passes, chain } = await captures(), prepared = await prepareKeyframeInput(passes, study.source.definitions, job.art ? await stored(job.art) : null, chain);
      kf.attempt = { token: randomUUID(), cost: job.keyframe_reservation, status: "submitting" }; kf.gate_object_id = prepared.gate_object_id;
      return post(kf.attempt, arrays, KEYFRAME_MODEL, () => assetBackend("illustration", "submit", { prompt: job.prompt, model: KEYFRAME_MODEL,
        reservation: job.keyframe_reservation, parameters: job.keyframe_parameters, inputs: prepared.inputs }));
    }
    if (attempt.status === "submitting" || attempt.status === "submission_unknown") return halt(attempt, arrays);
    if (attempt.status === "failed" || attempt.status === "refused") return fail("A keyframe was not painted. Unspent reservation released.");
    const result = await poll(attempt, arrays, `requests/${encodeURIComponent(attempt.request_id!)}?model=${encodeURIComponent(KEYFRAME_MODEL)}`, "illustration");
    if (typeof result === "number") return result;
    const urls = ((result.images ?? [result.image]) as { url?: unknown }[]).map(image => meshDownloadUrl(image?.url)), { passes, chain } = await captures();
    // The gate runs at most once: "started" is saved before the call, the
    // result before any download, and a "started" found later is an outage.
    if (!kf.gate) {
      kf.gate = { status: "started" }; await save(arrays());
      const body = await keyframeGateBody(passes, kf.gate_object_id ?? null, urls);
      kf.gate = { status: body ? "outage" : "no_building" };
      if (body) try {
        const masks = (await assetBackend("illustration", "gate", body, 200_000, 2_000_000))?.masks;
        if (Array.isArray(masks) && masks.length === urls.length && masks.every(m => m && (m.mask_png === null || typeof m.mask_png === "string"))) kf.gate = { status: "measured", masks: masks.map(m => m.mask_png) };
      } catch { /* An outage keeps candidate 0, unmeasured. */ }
      await save(arrays());
    } else if (kf.gate.status === "started") { kf.gate = { status: "outage" }; await save(arrays()); }
    const candidates: Buffer[] = [];
    for (const url of urls) candidates.push(await download(url));
    const { bytes, ...painted } = await finishKeyframe(passes, kf.gate_object_id ?? null, candidates, kf.gate.status === "measured" ? kf.gate.masks : null, chain);
    const saved = file(`keyframe${k}`, "jpg", bytes);
    await uploadJpeg(saved.key, bytes, "image/jpeg", AbortSignal.timeout(90_000));
    // A passing gate is the acceptance; a failed gate keeps the best candidate, flagged.
    attempt.status = "ready"; kf.result = painted; kf.file = saved; await save(arrays()); return 0;
  }

  const l = job.legs.findIndex(leg => leg.chosen === undefined);
  if (l >= 0) {
    const leg = job.legs[l]!, arrays = () => ({ legs: job.legs }), from = job.keyframes[l]!, to = job.keyframes[l + 1]!;
    const { width, height } = study.source.view, last = leg.attempts.at(-1);
    if (!last || last.status === "ready" && leg.retry === "reserved" && leg.attempts.length === 1) {
      const image = async (kf: PathVideoKeyframe) => {
        const bytes = await stored(kf.file);
        return { url: `data:image/${bytes[0] === 0x89 ? "png" : "jpeg"};base64,${bytes.toString("base64")}`, sha256: kf.file!.sha256, bytes: kf.file!.bytes, width, height };
      };
      const [start, end] = await Promise.all([image(from), image(to)]), attempt: LegAttempt = { token: randomUUID(), cost: leg.cost, status: "submitting" };
      leg.attempts.push(attempt);
      return post(attempt, arrays, LEG_MODEL, () => assetBackend("motion", "leg", { reservation: leg.cost, duration: leg.duration, move: leg.move, start, end }));
    }
    if (last.status === "submitting" || last.status === "submission_unknown") return halt(last, arrays);
    if (last.status === "failed" || last.status === "refused") return fail("A leg was not made. Unspent reservation released.");
    if (last.status !== "ready") {
      const result = await poll(last, arrays, `requests/${encodeURIComponent(last.request_id!)}?model=leg`, "motion");
      if (typeof result === "number") return result;
      const raw = await download((result.video as { url?: unknown } | undefined)?.url as string), n = leg.attempts.length - 1;
      last.original = file(`leg${l}-${n}-original`, "mp4", raw);
      await uploadJpeg(last.original.key, raw, "video/mp4", AbortSignal.timeout(90_000));
      // Motion is measured on the raw clip; retimed frames would break the run rule.
      const { fps, deltas, frames } = await legMotion(raw);
      const endAt = motionEnd(deltas, fps) || frames.length / fps, at = Math.min(frames.length, Math.max(1, Math.round(endAt * fps))) - 1;
      const prevGray = await grayFrame(await stored(from.file)), nextGray = await grayFrame(await stored(to.file));
      const check = landCheck({ cutFrame: frames[at]!, nextKeyframe: nextGray, prevKeyframe: prevGray, deltasBeforeCut: deltas.slice(0, at) });
      const factor = Math.min(2, Math.max(.5, leg.seconds / endAt)), cut = await cutLeg(raw, endAt, factor, { width, height });
      last.cut = file(`leg${l}-${n}-cut`, "mp4", cut);
      await uploadJpeg(last.cut.key, cut, "video/mp4", AbortSignal.timeout(90_000));
      Object.assign(last, { status: "ready", metrics: { end: round(endAt, 3), land: round(check.land, 3), snap: round(check.snap, 3), ok: check.ok, factor: round(factor, 3) } });
      await save(arrays());
    }
    if (!last.metrics!.ok && leg.attempts.length === 1 && !leg.retry) {
      // Exactly one retry, reserved on its own, on the job's scheduling day.
      try {
        if (round(job.reservation + leg.cost, 6) > PATH_VIDEO_CAP_USD) throw new CreatorError(`it would pass the $${PATH_VIDEO_CAP_USD} cap`, 409);
        await withDbTransaction(async (db, session) => {
          const options = { session }, jobs = db.collection<PathVideoDoc>("path_videos");
          if (!await jobs.findOne(live, options)) throw new Error("Path video lease lost");
          await reserveGenerationSpend(db, session, job.session_id, "motion", leg.cost, "MOTION_DAILY_CAP_USD", job.created_at, "3");
          await jobs.updateOne(live, { $set: { legs: job.legs.map((item, i) => i === l ? { ...item, retry: "reserved" } : item) }, $inc: { reservation: leg.cost } }, options);
        });
        return 0;
      } catch (e) {
        if (!(e instanceof CreatorError)) throw e;
        leg.retry = `Retry not reserved: ${e.message}`;
      }
    }
    // A landed attempt wins; otherwise keep the one that came closest.
    const landed = leg.attempts.findIndex(a => a.metrics!.ok);
    const best = landed >= 0 ? landed : leg.attempts.reduce((b, a, i) => a.metrics!.land < leg.attempts[b]!.metrics!.land ? i : b, 0);
    Object.assign(leg, { chosen: best, landed: leg.attempts[best]!.metrics!.ok }); await save(arrays()); return 0;
  }

  const cuts: Buffer[] = [];
  for (const leg of job.legs) cuts.push(await stored(leg.attempts[leg.chosen!]!.cut));
  const { bytes, media } = await joinLegs(cuts), video = file("video", "mp4", bytes);
  await uploadJpeg(video.key, bytes, "video/mp4", AbortSignal.timeout(90_000));
  await settle(db, live, "ready", { video, media }); return 0;
}

export async function processNextPathVideo(db: Db) {
  const col = db.collection<PathVideoDoc>("path_videos"), token = randomUUID(), now = new Date();
  const job = await col.findOneAndUpdate({ status: { $in: ["scheduled", "running"] }, $and: [
    { $or: [{ next_check: { $exists: false } }, { next_check: { $lte: now } }] },
    { $or: [{ work_until: { $exists: false } }, { work_until: { $lt: now } }] }] },
  { $set: { status: "running", work_token: token, work_until: new Date(Date.now() + 600_000) } }, { sort: { next_check: 1, created_at: 1 }, returnDocument: "after" });
  if (!job) return false;
  let wait: number, error = "";
  try { wait = await step(db, job, token); }
  catch { wait = 30_000; error = "A path video step is unavailable and will be tried again. No paid step is sent twice."; }
  const errors = error ? (job.errors ?? 0) + 1 : 0, live = { _id: job._id, work_token: token, status: "running" as const };
  // Storage, decode or status outages retry for about ten minutes, then stop.
  if (errors >= 20) await settle(db, live, "failed", { error: "Path video storage or provider stayed unavailable. Unspent reservation released." });
  else await col.updateOne(live, error ? { $set: { error } } : { $unset: { error: "" } });
  await col.updateOne({ _id: job._id, work_token: token }, { $set: { next_check: new Date(Date.now() + wait), errors }, $unset: { work_token: "", work_until: "" } });
  return true;
}

// Routes. New generation needs PATH_VIDEO_ENABLED=1; the worker always
// finishes jobs that are already paid for.
async function access(sid: string, studyId: string) {
  if (process.env.PATH_VIDEO_ENABLED !== "1") throw new CreatorError("Path videos are not enabled", 404);
  if (!isSafeId(studyId)) throw new CreatorError("Invalid motion study id", 400);
  return requireCreator(sid);
}
const wire = (job: PathVideoDoc) => ({ id: job.id, status: job.status, reservation: job.reservation, committed: job.committed,
  created_at: job.created_at.toISOString(), ...(job.error ? { error: job.error } : {}), ...(job.media ? { media: job.media } : {}),
  keyframes: job.keyframes.map(kf => ({ time: kf.time, stage: kf.stage, status: kf.file ? "ready" : kf.attempt?.status ?? "waiting",
    ...(kf.result ? { gate: kf.result.gate, passed: kf.result.passed } : {}) })),
  legs: job.legs.map(leg => ({ seconds: leg.seconds, duration: leg.duration, ...(leg.landed === undefined ? {} : { landed: leg.landed }),
    attempts: leg.attempts.map(a => ({ status: a.status, ...(a.metrics ? { land: a.metrics.land, snap: a.metrics.snap, ok: a.metrics.ok } : {}) })) })) });
export async function pathVideoLibrary(sid: string, studyId: string) {
  const db = await access(sid, studyId);
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${sid}:${studyId}`, session_id: sid });
  if (!study) throw new CreatorError("Motion study not found", 404);
  const jobs = await db.collection<PathVideoDoc>("path_videos").find({ session_id: sid, study_id: studyId }).sort({ created_at: -1 }).limit(20).toArray();
  let checkpoints = 0, quote: Omit<Awaited<ReturnType<typeof pathVideoQuote>>, "keyframe_parameters"> | null = null, reason = "";
  try {
    await currentMotionStudy(db, sid, studyId);
    const plan = pathVideoPlan(study); checkpoints = plan.keyframes.length;
    const { keyframe_parameters: _parameters, ...priced } = await pathVideoQuote(db, plan); quote = priced;
  } catch (e) { reason = e instanceof CreatorError ? e.message : "Path video backend unavailable"; }
  return { study_sha256: viewHash(study), checkpoints, quote, reason, jobs: jobs.map(wire) };
}
async function submitPathVideo(sid: string, studyId: string, input: Record<string, unknown>) {
  const db = await access(sid, studyId);
  if (!isSafeId(input.id) || input.id.length > 121 || input.confirmed !== true || typeof input.study_sha256 !== "string"
    || typeof input.prompt !== "string" || input.prompt.trim().length < 3 || input.prompt.length > 1024)
    throw new CreatorError("An appearance prompt and explicit priced consent are required", 400);
  const id = input.id, key = `${sid}:${id}`, requestHash = viewHash(input), sha = input.study_sha256, prompt = input.prompt.trim();
  const same = (job: PathVideoDoc) => {
    if (job.study_id !== studyId || job.request_sha256 !== requestHash) throw new CreatorError("Path video request identity already used", 409);
    return { job: wire(job) };
  };
  const prior = await db.collection<PathVideoDoc>("path_videos").findOne({ _id: key, session_id: sid });
  if (prior) return same(prior);
  const { study } = await currentMotionStudy(db, sid, studyId, sha);
  const plan = pathVideoPlan(study), quote = await pathVideoQuote(db, plan);
  if (input.reservation !== quote.reservation) throw new CreatorError("Path video price changed. Review the reservation.", 409);
  const art = plan.keyframes[0]!.stage === "first" ? await keyframeArt(db, sid, study.source.view.root_place_id) : null;
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<PathVideoDoc>("path_videos");
    const old = await jobs.findOne({ _id: key }, options); if (old) return same(old);
    const { view } = await currentMotionStudy(db, sid, studyId, sha, session);
    if (await jobs.countDocuments({ session_id: sid, study_id: studyId }, options) >= 20) throw new CreatorError("Motion study already has 20 path videos", 409);
    await fenceViewSources(db, view, session);
    // The ledger day of the full estimate; a leg retry reserves on the same day.
    const now = new Date(), ledger_ids = await reserveGenerationSpend(db, session, sid, "motion", quote.reservation, "MOTION_DAILY_CAP_USD", now, "3");
    const job: PathVideoDoc = { _id: key, id, session_id: sid, study_id: studyId, study_sha256: sha, preparation_sha256: study.preparation_sha256,
      request_sha256: requestHash, created_at: now, status: "scheduled", prompt, reservation: quote.reservation, committed: 0, ledger_ids,
      keyframe_reservation: quote.keyframe_reservation, keyframe_parameters: quote.keyframe_parameters, art, duration: plan.duration, subject: plan.subject,
      keyframes: plan.keyframes, legs: plan.legs.map((leg, i) => ({ ...leg, cost: quote.legs[i]!.reservation, attempts: [] })) };
    await jobs.insertOne(job, options); return { job: wire(job) };
  });
}
export async function pathVideoAction(sid: string, studyId: string, input: Record<string, unknown>) {
  if (input.action === "generate") return submitPathVideo(sid, studyId, input);
  const db = await access(sid, studyId);
  if (input.action !== "cancel" || !isSafeId(input.id)) throw new CreatorError("Invalid path video action", 400);
  const guard = { _id: `${sid}:${input.id}`, session_id: sid, study_id: studyId };
  if (await settle(db, { ...guard, status: { $in: ACTIVE } }, "cancelled", { error: "Cancelled. Unspent reservation released; steps already sent may remain billable." })) return { saved: true };
  const job = await db.collection<PathVideoDoc>("path_videos").findOne(guard);
  if (!job) throw new CreatorError("Path video missing", 404);
  if (job.status !== "cancelled") throw new CreatorError("Path video already finished", 409);
  return { saved: true };
}
export async function pathVideoBytes(sid: string, studyId: string, id: string) {
  const db = await access(sid, studyId);
  if (!isSafeId(id)) throw new CreatorError("Invalid path video identity", 400);
  const job = await db.collection<PathVideoDoc>("path_videos").findOne({ _id: `${sid}:${id}`, session_id: sid, study_id: studyId });
  if (job?.status !== "ready" || job.media?.audio_streams !== 0) throw new CreatorError("Path video unavailable", 404);
  const bytes = await verified(job.video);
  if (!bytes) throw new CreatorError("Path video unavailable or corrupted", 503);
  return bytes;
}
