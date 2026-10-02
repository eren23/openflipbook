/**
 * Path videos: a keyframe painted at each checkpoint of a saved motion study
 * (an orbit) or at each of an ordered list of saved views (a walk), then one
 * H3 first/last-frame leg between each pair, trimmed, land-checked and
 * joined. The worker does one leased step per tick. Each paid step is
 * claimed on the document (its cost committed) before its one POST, so a lost
 * response stays submission_unknown and is never sent again.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db, Filter } from "mongodb";
import { MathUtils } from "three";
import { withDbTransaction } from "./db";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { assetBackend } from "./mesh-execution";
import { meshDownloadUrl } from "./mesh-asset";
import { download, verified } from "./motion-execution";
import { motionQuote } from "./motion-job-server";
import { currentMotionStudy, motionSourceImage } from "./motion-source";
import { assertCurrentView, fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import { reserveGenerationSpend } from "./generation-reservation";
import { chainShift, illustrationDependency, keyframeArt, keyframeViewPasses } from "./illustration-input";
import { finishKeyframe, keyframeGateBody, prepareKeyframeInput, type KeyframeChain, type KeyframePasses } from "./illustration-keyframe-server";
import { KEYFRAME_MODEL } from "./asset-pipeline";
import { H3_CAMERA_ADAPTER } from "./camera-motion";
import { MAX_CHECKPOINTS, sampleCameraPath, type CameraKeyframe, type OrbitPose } from "./camera-path";
import { cutLeg, grayFrame, joinLegs, landCheck, legMotion, motionEnd } from "./motion-video";
import { uploadJpeg } from "./r2";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionFile } from "./motion-job";
import type { KeyframeGateDoc, MeshAssetDoc } from "./mesh-docs";
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
const ground = (pose: OrbitPose) => pose.distance * Math.cos(MathUtils.degToRad(pose.elevation));
/**
 * The /motion/leg move between two path times. A positive orbit moves the
 * camera to its own right (azimuth grows from +Z toward +X, see orbitPosition).
 * rise is the change in height over the pivot; forward is how much closer to
 * the pivot the camera ends on the ground plane, so the two never share one
 * move. The camera keeps facing the pivot, so no turn.
 */
export function legMove(keyframes: readonly CameraKeyframe[], from: number, to: number, subject: string | null) {
  const a = sampleCameraPath(keyframes, from), b = sampleCameraPath(keyframes, to);
  return { orbit_deg: round(clamp(b.azimuth - a.azimuth, 180)), turn_deg: 0, rise_m: round(clamp(height(b) - height(a), 500)),
    forward_m: round(clamp(ground(a) - ground(b), 500)), subject };
}
/**
 * The /motion/leg move between two cameras (column-major world matrices in
 * one frame, no roll). Forward is the eye's move along A's level heading,
 * turn the signed change of heading (positive = the camera turns to its own
 * right; the walk's ArrowRight lowers yaw), rise the change in eye height.
 */
export function viewMove(a: readonly number[], b: readonly number[], subject: string | null) {
  const level = (m: readonly number[]) => { const n = Math.hypot(m[8]!, m[10]!); return [-m[8]! / n, -m[10]! / n] as const; };
  const [fx, fz] = level(a), [gx, gz] = level(b), r = (n: number) => round(clamp(n, 500)) || 0;
  // A's level right is its heading turned a quarter to the right: (-fz, fx).
  return { orbit_deg: 0, turn_deg: r(MathUtils.radToDeg(Math.atan2(-gx * fz + gz * fx, gx * fx + gz * fz))), rise_m: r(b[13]! - a[13]!),
    forward_m: r((b[12]! - a[12]!) * fx + (b[14]! - a[14]!) * fz), subject };
}
// Walk leg timing: walking speed, and at least this long for a turn on the spot. Tune here.
export const WALK_SPEED_MPS = 1.4;
export const WALK_LEG_MIN_SECONDS = 1.5;

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
  _id: string; id: string; session_id: string;
  // The source: a motion study, or (a walk video) saved views of one place in order.
  study_id?: string; study_sha256?: string; preparation_sha256?: string;
  place_id?: string; view_ids?: string[]; views_sha256?: string;
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
type Plan = ReturnType<typeof pathVideoPlan>;
// Camera A moved into camera B's frame (walk views draw the root place at its chunk offset).
const inFrame = <T extends Pick<PlaceViewDoc, "root_place_id" | "sources" | "camera">>(a: T, b: Pick<PlaceViewDoc, "root_place_id" | "sources">): T => {
  const shift = chainShift(a, b)!;
  return { ...a, camera: { ...a.camera, world_matrix: a.camera.world_matrix.map((v, i) => v + (i === 12 ? shift.x : i === 14 ? shift.z : 0)) } };
};
/** Keyframes at saved views in order, and a leg between each pair; throws 409 when the views cannot make one video. */
export function walkVideoPlan(views: readonly PlaceViewDoc[]): Plan {
  const first = views[0]!;
  if (views.some(v => v.mode === "plan" || v.width !== first.width || v.height !== first.height || !chainShift(v, first)))
    throw new CreatorError("Use 3D views of one place, saved at one size", 409);
  const legs = views.slice(1).map((b, i) => {
    const a = inFrame(views[i]!, b).camera.world_matrix, m = b.camera.world_matrix;
    const seconds = round(Math.max(WALK_LEG_MIN_SECONDS, Math.hypot(m[12]! - a[12]!, m[13]! - a[13]!, m[14]! - a[14]!) / WALK_SPEED_MPS), 3);
    return { seconds, duration: legSeconds(seconds), move: viewMove(a, m, null) };
  });
  const duration = round(legs.reduce((sum, leg) => sum + leg.seconds, 0), 3);
  let elapsed = 0;
  return { subject: null, duration, legs, keyframes: views.map((view, i): PathVideoKeyframe => {
    if (i) elapsed += legs[i - 1]!.seconds;
    return { frame: i, time: round(elapsed / duration, 6), stage: i ? "chain" : view.accepted_illustration_id ? "source" : "first" };
  }) };
}
const viewsHash = (views: readonly PlaceViewDoc[]) => viewHash(views.map(illustrationDependency));

// What one job paints and how it is priced and fenced. `image` is keyframe 0's
// accepted artwork, when it is not painted.
interface Source {
  plan: Plan; sha256: string; image: { asset_id: string | null; key: string; sha256: string; bytes: number } | null;
  size: { width: number; height: number }; place_id: string; fence: PlaceViewDoc[];
  identity: Partial<PathVideoDoc>; worker: "path_video_v1" | "path_video_views_v1";
}
function studySource(study: MotionStudyDoc, view: PlaceViewDoc): Source {
  const plan = pathVideoPlan(study);
  return { plan, sha256: viewHash(study), image: plan.keyframes[0]!.stage === "source" ? study.source.image : null, size: study.source.view,
    place_id: study.source.view.root_place_id, fence: [view], worker: "path_video_v1",
    identity: { study_id: study.id, study_sha256: viewHash(study), preparation_sha256: study.preparation_sha256 } };
}
// Saved views of one place, in order and each current. `sha` pins them for a submission.
async function walkSource(db: Db, sid: string, pid: string, ids: unknown, sha?: unknown, session?: ClientSession): Promise<Source> {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_CHECKPOINTS || !ids.every(isSafeId) || new Set(ids).size !== ids.length)
    throw new CreatorError(`A walk video needs 2 to ${MAX_CHECKPOINTS} saved views`, 400);
  const options = session ? { session } : {}, views: PlaceViewDoc[] = [];
  for (const id of ids) {
    const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${id}`, session_id: sid }, options);
    if (!view) throw new CreatorError("Saved view not found", 404);
    if (view.root_place_id !== pid) throw new CreatorError("Every view must be a camera of this place", 409);
    await assertCurrentView(db, view, session);
    views.push(view);
  }
  const sha256 = viewsHash(views);
  if (sha !== undefined && sha !== sha256) throw new CreatorError("Saved views changed. Review the walk video.", 409);
  const plan = walkVideoPlan(views), accepted = views[0]!.accepted_illustration_id;
  const asset = accepted ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${accepted}`, session_id: sid }, options) : null;
  if (accepted && !asset) throw new CreatorError("Accepted artwork is unavailable", 409);
  const image = asset && { asset_id: asset.id, key: asset.key, sha256: asset.sha256, bytes: asset.bytes };
  // The accepted artwork is keyframe 0 as it is now.
  if (image) plan.keyframes[0]!.file = { key: image.key, sha256: image.sha256, bytes: image.bytes };
  return { plan, sha256, image, size: views[0]!, place_id: pid, fence: views, worker: "path_video_views_v1",
    identity: { place_id: pid, view_ids: ids, views_sha256: sha256 } };
}

async function pathVideoQuote(db: Db, sid: string, { plan, image, size, worker }: Source) {
  // /motion/leg reads the accepted source as leg 0's start: check it before any spend.
  if (image) await motionSourceImage({ source: { image, view: size } });
  const config = await assetBackend("illustration", "keyframe-capabilities");
  if (!config?.enabled || config.model !== KEYFRAME_MODEL || !Number.isFinite(config.reservation) || config.reservation <= 0 || !config.parameters)
    throw new CreatorError("Keyframe painting is not configured", 503);
  const costs = new Map<number, number>();
  for (const { duration } of plan.legs) if (!costs.has(duration)) costs.set(duration, (await motionQuote(db, duration)).reservation);
  if (!await db.collection("generation_workers").findOne({ kind: "place-layout", [worker]: true, last_seen: { $gt: new Date(Date.now() - 30_000) } }))
    throw new CreatorError("Compatible path video worker unavailable", 503);
  const micros = (n: number) => Math.round(n * 1_000_000), paid = plan.keyframes.filter(k => k.stage !== "source").length;
  const reservation = (paid * micros(config.reservation) + plan.legs.reduce((sum, leg) => sum + micros(costs.get(leg.duration)!), 0)) / 1_000_000;
  if (reservation > PATH_VIDEO_CAP_USD) throw new CreatorError(`This path video needs $${reservation.toFixed(2)}, over the $${PATH_VIDEO_CAP_USD} cap. Shorten the path.`, 409);
  // Every keyframe is painted like a first one. When keyframe 0 is accepted
  // artwork, its own prompt is the appearance; otherwise the user words it.
  const source = image ? (await db.collection<MeshAssetDoc>("illustration_assets")
    .findOne({ _id: `${sid}:${image.asset_id}`, session_id: sid }))?.prompt.trim() ?? "" : "";
  const sourcePrompt = source.length >= 3 && source.length <= 1024 ? source : null;
  return { reservation, paid_keyframes: paid, appearance: !sourcePrompt, source_prompt: sourcePrompt, keyframe_reservation: config.reservation as number, keyframe_parameters: config.parameters as Record<string, unknown>,
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
// The captures a job paints at, by frame index: a study's frames or the job's
// saved views. Null when they changed. `sources` throws 409 for changed geometry.
async function jobFrames(db: Db, job: PathVideoDoc) {
  if (job.view_ids) {
    const found = await Promise.all(job.view_ids.map(id => db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${job.session_id}:${id}`, session_id: job.session_id })));
    const views = found.filter(view => view !== null);
    if (views.length !== found.length || viewsHash(views) !== job.views_sha256) return null;
    return { size: views[0]!, source: null, passes: (i: number) => keyframeViewPasses(views[i]!),
      chain: async (a: number, b: number) => ({ view: inFrame(views[a]!, views[b]!), depth: await stored(views[a]!.files.depth) }),
      sources: (i: number) => assertCurrentView(db, views[i]!) };
  }
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${job.session_id}:${job.study_id}`, session_id: job.session_id });
  if (!study || viewHash(study) !== job.study_sha256) return null;
  return { size: study.source.view, source: study.source.image, passes: (i: number) => framePasses(study, i),
    chain: async (a: number) => ({ view: frameView(study, a), depth: await stored(study.files[a]!.depth) }),
    sources: async () => study.source.definitions };
}

// One step of one job. Returns how long to wait before its next step.
async function step(db: Db, job: PathVideoDoc, token: string): Promise<number> {
  const col = db.collection<PathVideoDoc>("path_videos"), lease = { _id: job._id, work_token: token }, live = { ...lease, status: "running" as const };
  const save = async (set: Partial<PathVideoDoc>) => { if (!(await col.updateOne(live, { $set: set })).matchedCount) throw new Error("Path video lease lost"); };
  const fail = async (error: string) => { await settle(db, live, "failed", { error }); return 0; };
  const frames = await jobFrames(db, job);
  if (!frames) return fail(job.view_ids ? "A saved view changed. Unspent reservation released." : "The motion study changed. Unspent reservation released.");
  const file = (name: string, ext: string, bytes: Buffer): MotionFile => ({ key: `${job.session_id}/path-videos/${job.id}/${name}-${hash(bytes)}.${ext}`, sha256: hash(bytes), bytes: bytes.length });
  const halt = async (attempt: Attempt, arrays: () => Partial<PathVideoDoc>) => {
    attempt.status = "submission_unknown";
    await col.updateOne(lease, { $set: arrays() });
    await col.updateOne(live, { $set: { status: "submission_unknown", error: "A paid response was lost. It may be billable; nothing is sent again. Cancel to release the rest." } });
    return 0;
  };
  // A refused step was never sent: un-commit its cost. If a cancel settled the
  // job meanwhile, that release counted this cost as spent, so release it here.
  const uncommit = (attempt: Attempt, arrays: () => Partial<PathVideoDoc>) => withDbTransaction(async (db, session) => {
    const jobs = db.collection<PathVideoDoc>("path_videos"), options = { session }, doc = await jobs.findOne(lease, options);
    if (!doc) return;
    if (!ACTIVE.includes(doc.status)) for (const id of doc.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -attempt.cost } }, options);
    await jobs.updateOne(lease, { $set: arrays(), $inc: { committed: -attempt.cost } }, options);
  });
  // Claim (cost committed) -> one POST -> request id. A refused or failed
  // step is only recorded here; the next step decides what it means.
  const post = async (attempt: Attempt, arrays: () => Partial<PathVideoDoc>, model: string, send: () => Promise<Record<string, unknown>>) => {
    if (!(await col.updateOne({ ...live, work_until: { $gt: new Date(Date.now() + 120_000) } }, { $set: arrays(), $inc: { committed: attempt.cost } })).matchedCount) return 0;
    let receipt: Record<string, unknown> | undefined;
    try { receipt = await send(); }
    catch (e) {
      if (!refused(e)) return halt(attempt, arrays);
      attempt.status = "refused"; await uncommit(attempt, arrays); return 0;
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
    if (result?.status === "failed") { attempt.status = "failed"; await save(arrays()); return 0; }
    if (result?.status !== "ready") throw new Error("Unknown provider state");
    return result as Record<string, unknown>;
  };

  const k = job.keyframes.findIndex(kf => !kf.file);
  if (k >= 0) {
    const kf = job.keyframes[k]!, arrays = () => ({ keyframes: job.keyframes, legs: job.legs });
    if (kf.stage === "source") {
      // The accepted study source image is keyframe 0; nothing is painted.
      // (A walk video pins view 0's accepted artwork when it is scheduled.)
      const { key, sha256, bytes } = frames.source!;
      await stored({ key, sha256, bytes });
      kf.file = { key, sha256, bytes }; await save(arrays()); return 0;
    }
    const prev = job.keyframes[k - 1], attempt = kf.attempt;
    // Keyframe i is chained from keyframe i-1 (its camera, depth pass and image).
    const captures = async () => ({ passes: await frames.passes(kf.frame),
      chain: prev ? { ...await frames.chain(prev.frame, kf.frame), image: await stored(prev.file) } as KeyframeChain : undefined });
    if (!attempt) {
      const sources = await frames.sources(kf.frame).catch(e => { if (e instanceof CreatorError) return null; throw e; });
      if (!sources) return fail("The walk's geometry changed. Unspent reservation released.");
      const { passes, chain } = await captures(), prepared = await prepareKeyframeInput(passes, sources, job.art ? await stored(job.art) : null, chain);
      // A walk leg heads toward the building its end keyframe's gate measures (the most visible one).
      if (job.view_ids && k > 0 && prepared.gate_object_id) job.legs[k - 1]!.move.subject = sources.flatMap(s => s.definition.objects).find(o => o.id === prepared.gate_object_id)?.label.slice(0, 120) ?? null;
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
    const { width, height } = frames.size, last = leg.attempts.at(-1);
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
    // A failed or refused retry leaves the first attempt to choose from.
    if ((last.status === "failed" || last.status === "refused") && leg.attempts.length === 1) return fail("A leg was not made. Unspent reservation released.");
    if (last.status === "queued" || last.status === "running") {
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
    if (leg.attempts.length === 1 && !leg.retry && !last.metrics!.ok) {
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
    const measured = leg.attempts.flatMap((a, i) => a.metrics ? [{ i, ...a.metrics }] : []);
    const best = measured.find(a => a.ok) ?? measured.reduce((b, a) => a.land < b.land ? a : b);
    Object.assign(leg, { chosen: best.i, landed: best.ok }); await save(arrays()); return 0;
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
  // Storage, decode or status outages retry for about ten minutes, then stop,
  // unless a paid result is still unread: that job stays resumable and backs
  // off to hourly checks until the result is read or the job is cancelled.
  const unread = [...job.keyframes.map(kf => kf.attempt), ...job.legs.flatMap(leg => leg.attempts)].some(a => a?.request_id && (a.status === "queued" || a.status === "running"));
  if (errors >= 20 && !unread) await settle(db, live, "failed", { error: "Path video storage or provider stayed unavailable. Unspent reservation released." });
  else await col.updateOne(live, error ? { $set: { error } } : { $unset: { error: "" } });
  if (errors >= 20) wait = Math.min(3_600_000, wait * 2 ** (errors - 20));
  await col.updateOne({ _id: job._id, work_token: token }, { $set: { next_check: new Date(Date.now() + wait), errors }, $unset: { work_token: "", work_until: "" } });
  return true;
}

// Routes. New generation needs PATH_VIDEO_ENABLED=1; the worker always
// finishes jobs that are already paid for. A job belongs to a motion study,
// or (a walk video) to the place its saved views belong to.
type Scope = { study_id: string } | { place_id: string };
async function access(sid: string, id: string, kind = "motion study") {
  if (process.env.PATH_VIDEO_ENABLED !== "1") throw new CreatorError("Path videos are not enabled", 404);
  if (!isSafeId(id)) throw new CreatorError(`Invalid ${kind} id`, 400);
  return requireCreator(sid);
}
const wire = (job: PathVideoDoc) => ({ id: job.id, status: job.status, reservation: job.reservation, committed: job.committed,
  created_at: job.created_at.toISOString(), ...(job.error ? { error: job.error } : {}), ...(job.media ? { media: job.media } : {}),
  keyframes: job.keyframes.map(kf => ({ time: kf.time, stage: kf.stage, status: kf.file ? "ready" : kf.attempt?.status ?? "waiting",
    ...(kf.result ? { gate: kf.result.gate, passed: kf.result.passed } : {}) })),
  legs: job.legs.map(leg => ({ seconds: leg.seconds, duration: leg.duration, ...(leg.landed === undefined ? {} : { landed: leg.landed }),
    attempts: leg.attempts.map(a => ({ status: a.status, ...(a.metrics ? { land: a.metrics.land, snap: a.metrics.snap, ok: a.metrics.ok } : {}) })) })) });
const jobList = async (db: Db, sid: string, scope: Scope) =>
  (await db.collection<PathVideoDoc>("path_videos").find({ session_id: sid, ...scope }).sort({ created_at: -1 }).limit(20).toArray()).map(wire);
// A source's checkpoints and quote, or why it cannot make a video.
async function priced(db: Db, sid: string, load: () => Promise<Source>) {
  let sha256 = "", checkpoints = 0, quote: Omit<Awaited<ReturnType<typeof pathVideoQuote>>, "keyframe_parameters" | "source_prompt"> | null = null, reason = "";
  try {
    const source = await load(); sha256 = source.sha256; checkpoints = source.plan.keyframes.length;
    const { keyframe_parameters: _parameters, source_prompt: _prompt, ...rest } = await pathVideoQuote(db, sid, source); quote = rest;
  } catch (e) { reason = e instanceof CreatorError ? e.message : "Path video backend unavailable"; }
  return { sha256, checkpoints, quote, reason };
}
export async function pathVideoLibrary(sid: string, studyId: string) {
  const db = await access(sid, studyId);
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${sid}:${studyId}`, session_id: sid });
  if (!study) throw new CreatorError("Motion study not found", 404);
  const jobs = await jobList(db, sid, { study_id: studyId });
  const { sha256: _sha, ...rest } = await priced(db, sid, async () => studySource(study, (await currentMotionStudy(db, sid, studyId)).view));
  return { study_sha256: viewHash(study), ...rest, jobs };
}
/** Walk videos of a place. With view ids, also the quote for a video over those saved views. */
export async function walkVideoLibrary(sid: string, pid: string, viewIds: string[] | null) {
  const db = await access(sid, pid, "place"), jobs = await jobList(db, sid, { place_id: pid });
  const { sha256, ...rest } = viewIds ? await priced(db, sid, () => walkSource(db, sid, pid, viewIds)) : { sha256: "", checkpoints: 0, quote: null, reason: "" };
  return { views_sha256: sha256, ...rest, jobs };
}
// Reserve the full estimate and insert one job, after explicit priced consent.
// `load` returns the current source, again inside the transaction.
async function schedule(db: Db, sid: string, input: Record<string, unknown>, scope: Scope, load: (db: Db, session?: ClientSession) => Promise<Source>) {
  if (!isSafeId(input.id) || input.id.length > 121 || input.confirmed !== true) throw new CreatorError("Explicit priced consent is required", 400);
  const id = input.id, key = `${sid}:${id}`, requestHash = viewHash(input);
  const same = (job: PathVideoDoc) => {
    if (Object.entries(scope).some(([field, value]) => job[field as keyof PathVideoDoc] !== value) || job.request_sha256 !== requestHash) throw new CreatorError("Path video request identity already used", 409);
    return { job: wire(job) };
  };
  const prior = await db.collection<PathVideoDoc>("path_videos").findOne({ _id: key, session_id: sid });
  if (prior) return same(prior);
  const source = await load(db), { plan } = source, quote = await pathVideoQuote(db, sid, source);
  if (input.reservation !== quote.reservation) throw new CreatorError("Path video price changed. Review the reservation.", 409);
  const prompt = quote.source_prompt ?? (typeof input.prompt === "string" ? input.prompt.trim() : "");
  if (prompt.length < 3 || prompt.length > 1024) throw new CreatorError("An appearance prompt is required", 400);
  // Chains send the world's art too (words only for a world without art), so their holes are painted, not restyled.
  const art = await keyframeArt(db, sid, source.place_id);
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<PathVideoDoc>("path_videos");
    const old = await jobs.findOne({ _id: key }, options); if (old) return same(old);
    const { fence } = await load(db, session);
    if (await jobs.countDocuments({ session_id: sid, ...scope }, options) >= 20) throw new CreatorError("place_id" in scope ? "This place already has 20 walk videos" : "Motion study already has 20 path videos", 409);
    for (const view of fence) await fenceViewSources(db, view, session);
    // The ledger day of the full estimate; a leg retry reserves on the same day.
    const now = new Date(), ledger_ids = await reserveGenerationSpend(db, session, sid, "motion", quote.reservation, "MOTION_DAILY_CAP_USD", now, "3");
    const job: PathVideoDoc = { _id: key, id, session_id: sid, ...source.identity,
      request_sha256: requestHash, created_at: now, status: "scheduled", prompt, reservation: quote.reservation, committed: 0, ledger_ids,
      keyframe_reservation: quote.keyframe_reservation, keyframe_parameters: quote.keyframe_parameters, art, duration: plan.duration, subject: plan.subject,
      keyframes: plan.keyframes, legs: plan.legs.map((leg, i) => ({ ...leg, cost: quote.legs[i]!.reservation, attempts: [] })) };
    await jobs.insertOne(job, options); return { job: wire(job) };
  });
}
async function cancel(db: Db, sid: string, scope: Scope, input: Record<string, unknown>) {
  if (input.action !== "cancel" || !isSafeId(input.id)) throw new CreatorError("Invalid path video action", 400);
  const guard = { _id: `${sid}:${input.id}`, session_id: sid, ...scope };
  if (await settle(db, { ...guard, status: { $in: ACTIVE } }, "cancelled", { error: "Cancelled. Unspent reservation released; steps already sent may remain billable." })) return { saved: true };
  const job = await db.collection<PathVideoDoc>("path_videos").findOne(guard);
  if (!job) throw new CreatorError("Path video missing", 404);
  if (job.status !== "cancelled") throw new CreatorError("Path video already finished", 409);
  return { saved: true };
}
export async function pathVideoAction(sid: string, studyId: string, input: Record<string, unknown>) {
  const db = await access(sid, studyId), sha = input.study_sha256;
  if (input.action !== "generate") return cancel(db, sid, { study_id: studyId }, input);
  if (typeof sha !== "string") throw new CreatorError("Explicit priced consent is required", 400);
  return schedule(db, sid, input, { study_id: studyId }, async (db, session) => {
    const { study, view } = await currentMotionStudy(db, sid, studyId, sha, session);
    return studySource(study, view);
  });
}
/** generate: one walk video over `view_ids` (pinned by `views_sha256`), or cancel. */
export async function walkVideoAction(sid: string, pid: string, input: Record<string, unknown>) {
  const db = await access(sid, pid, "place");
  if (input.action !== "generate") return cancel(db, sid, { place_id: pid }, input);
  if (typeof input.views_sha256 !== "string") throw new CreatorError("Explicit priced consent is required", 400);
  return schedule(db, sid, input, { place_id: pid }, (db, session) => walkSource(db, sid, pid, input.view_ids, input.views_sha256, session));
}
async function bytes(db: Db, sid: string, scope: Scope, id: string) {
  if (!isSafeId(id)) throw new CreatorError("Invalid path video identity", 400);
  const job = await db.collection<PathVideoDoc>("path_videos").findOne({ _id: `${sid}:${id}`, session_id: sid, ...scope });
  if (job?.status !== "ready" || job.media?.audio_streams !== 0) throw new CreatorError("Path video unavailable", 404);
  const video = await verified(job.video);
  if (!video) throw new CreatorError("Path video unavailable or corrupted", 503);
  return video;
}
export const pathVideoBytes = async (sid: string, studyId: string, id: string) => bytes(await access(sid, studyId), sid, { study_id: studyId }, id);
export const walkVideoBytes = async (sid: string, pid: string, id: string) => bytes(await access(sid, pid, "place"), sid, { place_id: pid }, id);
