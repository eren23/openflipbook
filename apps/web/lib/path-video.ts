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
import { CHECKPOINT_MAX_DEGREES, checkpointFar, MAX_CHECKPOINTS, sampleCameraPath, type CameraKeyframe, type OrbitPose } from "./camera-path";
import { WALK_CHECKPOINT_METRES } from "./walk-route";
import { cutLeg, grayFrame, joinLegs, landCheck, legMotion, motionEnd, MAX_PATH_VIDEO_SECONDS } from "./motion-video";
import { getStoredBytes, uploadJpeg } from "./r2";
import type { SceneDoc } from "./place-scene-store";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionFile } from "./motion-job";
import type { KeyframeGateDoc, MeshAssetDoc } from "./mesh-docs";
import type { IllustrationKeyframe, KeyframeGateSubject } from "./place-view";
import { reviewedKeyframe, verifiedKeyframe } from "./illustration-verification";

export const PATH_VIDEO_CAP_USD = 10;
export const LEG_MODEL = "minimax/h3-max/image-to-video";
export const ACCEPTED_ONLY_POLICY = "accepted-only-v1";
export const ACCEPTED_ROUTE_POLICY = "accepted-route-v1";
type AcceptedPolicy = typeof ACCEPTED_ONLY_POLICY | typeof ACCEPTED_ROUTE_POLICY;
const acceptedPolicy = (policy: unknown): policy is AcceptedPolicy => policy === ACCEPTED_ONLY_POLICY || policy === ACCEPTED_ROUTE_POLICY;
export interface AcceptedVideoAnchor {
  view_id: string; asset_id: string; sha256: string; bytes: number; input_sha256: string; camera_sha256: string; source_sha256: string; review_sha256: string;
}
// Mirrors LEG_MIN_SECONDS and leg_seconds() in providers/video.py: H3 moves
// for the whole clip (research 37), so a leg asks for its planned length in
// whole seconds. Change both together. A backend that does not advertise its
// floor in /motion/capabilities (an old one) takes 5 s legs at least.
export const LEG_MIN_SECONDS = 3;
export const legSeconds = (planned: number, floor = LEG_MIN_SECONDS) => Math.max(floor, Math.min(15, Math.ceil(Number(planned.toFixed(6)))));

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
const height = (pose: OrbitPose) => pose.distance * Math.sin(MathUtils.degToRad(pose.elevation));
const ground = (pose: OrbitPose) => pose.distance * Math.cos(MathUtils.degToRad(pose.elevation));
export interface VideoMove { orbit_deg: number; turn_deg: number; rise_m: number; forward_m: number; lateral_m?: number; subject: string | null }
/**
 * The /motion/leg move between two path times. A positive orbit moves the
 * camera to its own right (azimuth grows from +Z toward +X, see orbitPosition).
 * rise is the change in height over the pivot; forward is how much closer to
 * the pivot the camera ends on the ground plane, so the two never share one
 * move. The camera keeps facing the pivot, so no turn.
 */
export function legMove(keyframes: readonly CameraKeyframe[], from: number, to: number, subject: string | null): VideoMove {
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
  const lateral = r(-(b[12]! - a[12]!) * fz + (b[14]! - a[14]!) * fx);
  // A's level right is its heading turned a quarter to the right: (-fz, fx).
  return { orbit_deg: 0, turn_deg: r(MathUtils.radToDeg(Math.atan2(-gx * fz + gz * fx, gx * fx + gz * fz))), rise_m: r(b[13]! - a[13]!),
    forward_m: r((b[12]! - a[12]!) * fx + (b[14]! - a[14]!) * fz), ...(lateral ? { lateral_m: lateral } : {}), subject };
}
// Walk leg timing: walking speed, and at least this long for a turn on the spot. Tune here.
export const WALK_SPEED_MPS = 1.4;
export const WALK_LEG_MIN_SECONDS = 1.5;

type AttemptState = "submitting" | "submission_unknown" | "queued" | "running" | "ready" | "failed" | "refused";
interface Attempt { token: string; cost: number; status: AttemptState; request_id?: string }
export interface PathVideoKeyframe {
  frame: number; time: number; stage: "source" | "first" | "chain";
  attempt?: Attempt; gate_object_id?: string | null; gate_subject?: KeyframeGateSubject | null; gate?: KeyframeGateDoc; file?: MotionFile;
  result?: Pick<IllustrationKeyframe, "gate" | "candidates" | "chosen" | "passed" | "sky_pinned" | "final_image"> & { chain?: { angle: number; hole_share: number } };
  // A failed gate is painted once more: retry is "reserved" or why not. `other` keeps the try not used.
  retry?: string; other?: KeyframeTry;
  // A keyframe still failing its gate is dropped: the next one chains from the
  // last kept keyframe, and one leg spans both steps. kept_reason: why it was not.
  dropped?: true; drop_reason?: string; kept_reason?: string;
  // The index of the keyframe this one chains from.
  chained_from?: number;
}
type KeyframeTry = Pick<PathVideoKeyframe, "attempt" | "gate" | "result" | "file">;
export interface LegAttempt extends Attempt {
  prompt?: string; original?: MotionFile; cut?: MotionFile;
  metrics?: { end: number; land: number; snap: number; ok: boolean; factor: number; timing?: boolean };
}
export interface PathVideoLeg {
  seconds: number; duration: number; cost: number; move: ReturnType<typeof legMove>;
  attempts: LegAttempt[]; retry?: string; chosen?: number; landed?: boolean;
  // Its end keyframe was dropped: never made, its reservation released when the job settles.
  // A leg after a dropped middle keyframe starts at the last kept keyframe instead.
  dropped?: true;
}
export type PathVideoState = "scheduled" | "running" | "submission_unknown" | "needs_review" | "ready" | "failed" | "cancelled";
export interface PathVideoDoc {
  _id: string; id: string; session_id: string;
  // The source: a motion study, or (a walk video) saved views of one place in order.
  study_id?: string; study_sha256?: string; preparation_sha256?: string;
  place_id?: string; view_ids?: string[]; views_sha256?: string;
  keyframe_policy?: AcceptedPolicy; accepted_anchors_sha256?: string; accepted_anchors?: AcceptedVideoAnchor[];
  request_sha256: string; created_at: Date; status: PathVideoState; prompt: string;
  reservation: number; committed: number; ledger_ids: string[];
  verification_version?: 2; retry_allowance?: 0 | 1; funding_released?: boolean;
  archive_provenance?: { version: 1; source_session_id: string; source_id: string; original_status: PathVideoState; committed: number };
  resume_history?: { id: string; request_sha256: string; created_at: Date; reservation: number; keyframes: PathVideoKeyframe[]; legs: PathVideoLeg[] }[];
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
    legs: times.slice(1).map((to, i) => ({ seconds: round(prep.path.duration * (to - times[i]!), 3), move: legMove(prep.path.keyframes, times[i]!, to, subject) })) };
}
type Plan = ReturnType<typeof pathVideoPlan>;
// Camera A moved into camera B's frame (walk views draw the root place at its chunk offset).
const inFrame = <T extends Pick<PlaceViewDoc, "root_place_id" | "sources" | "camera">>(a: T, b: Pick<PlaceViewDoc, "root_place_id" | "sources">): T => {
  const shift = chainShift(a, b)!;
  return { ...a, camera: { ...a.camera, world_matrix: a.camera.world_matrix.map((v, i) => v + (i === 12 ? shift.x : i === 14 ? shift.z : 0)) } };
};
// The real move from view a to view b, and how far the eye goes.
const viewStep = (a: PlaceViewDoc, b: PlaceViewDoc) => {
  const m = inFrame(a, b).camera.world_matrix, n = b.camera.world_matrix;
  return { move: viewMove(m, n, null), metres: Math.hypot(n[12]! - m[12]!, n[13]! - m[13]!, n[14]! - m[14]!) };
};
/** Keyframes at saved views in order, and a leg between each pair; throws 409 when the views cannot make one video. */
export function walkVideoPlan(views: readonly PlaceViewDoc[]): Plan {
  if (views.length < 2 || views.length > MAX_CHECKPOINTS) throw new CreatorError(`A walk video needs 2 to ${MAX_CHECKPOINTS} saved views`, 400);
  const first = views[0]!;
  if (views.some(v => v.mode === "plan" || v.width !== first.width || v.height !== first.height || !chainShift(v, first)))
    throw new CreatorError("Use 3D views of one place, saved at one size", 409);
  const legs = views.slice(1).map((b, i) => {
    const { move, metres } = viewStep(views[i]!, b);
    if (metres > WALK_CHECKPOINT_METRES + 1e-6 || Math.abs(move.turn_deg) > CHECKPOINT_MAX_DEGREES + 1e-6)
      throw new CreatorError("Walk checkpoints must be at most 4 metres or 30 degrees apart. Save intermediate cameras.", 409);
    return { seconds: round(Math.max(WALK_LEG_MIN_SECONDS, metres / WALK_SPEED_MPS), 3), move };
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
  identity: Partial<PathVideoDoc>; worker: "path_video_v2" | "path_video_views_v2";
  anchors?: NonNullable<Source["image"]>[];
  art?: { key: string; sha256: string };
}
function studySource(study: MotionStudyDoc, view: PlaceViewDoc): Source {
  const plan = pathVideoPlan(study);
  return { plan, sha256: viewHash(study), image: plan.keyframes[0]!.stage === "source" ? study.source.image : null, size: study.source.view,
    place_id: study.source.view.root_place_id, fence: [view], worker: "path_video_v2",
    identity: { study_id: study.id, study_sha256: viewHash(study), preparation_sha256: study.preparation_sha256 } };
}
// Saved views of one place, in order and each current. `sha` pins them for a submission.
async function walkSource(db: Db, sid: string, pid: string, ids: unknown, sha?: unknown, session?: ClientSession, policy?: unknown, anchorsSha?: unknown): Promise<Source> {
  if (policy !== undefined && !acceptedPolicy(policy)) throw new CreatorError("Unknown walk video keyframe policy", 400);
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
  if (acceptedPolicy(policy)) {
    if (policy === ACCEPTED_ONLY_POLICY && views.length !== 2) throw new CreatorError("Accepted-only video needs exactly two ordinary 688 × 384 saved cameras", 409);
    if (views.some(view => view.width !== 688 || view.height !== 384 || view.walk_checkpoint)) throw new CreatorError("Reviewed video anchors need ordinary 688 × 384 saved cameras", 409);
    const plan = walkVideoPlan(views), scene = await db.collection<SceneDoc>("place_scenes").findOne({ _id: `${sid}:${pid}`, session_id: sid }, options);
    if (!scene?.source_image_key) throw new CreatorError("Accepted-only anchors require their owned source map", 409);
    const map = await getStoredBytes(scene.source_image_key, AbortSignal.timeout(30_000));
    if (!map || !map.bytes.length || map.bytes.length > 12 * 1024 * 1024) throw new CreatorError("The owned source map is unavailable", 503);
    const sourceSha = hash(map.bytes), anchors: NonNullable<Source["image"]>[] = [], receipts: AcceptedVideoAnchor[] = [];
    for (const [i, view] of views.entries()) {
      const asset = view.accepted_illustration_id ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${view.accepted_illustration_id}`, session_id: sid }, options) : null;
      if (!asset || asset.content_type !== "image/jpeg" || viewHash(asset.view_dependency) !== viewHash(illustrationDependency(view)) || !reviewedKeyframe(asset.keyframe, asset.sha256)
        || asset.keyframe?.reference_preparation?.source_sha256 !== sourceSha || asset.keyframe.reference?.sha256 !== sourceSha)
        throw new CreatorError(policy === ACCEPTED_ONLY_POLICY ? "Both accepted anchors need current camera, source-map and exact-image review bindings"
          : `Camera ${i + 1}/${views.length} needs reviewed artwork bound to its current camera and source map`, 409);
      const image = { asset_id: asset.id, key: asset.key, sha256: asset.sha256, bytes: asset.bytes };
      const checked = await motionSourceImage({ source: { image, view } });
      if (!checked.url.startsWith("data:image/jpeg;")) throw new CreatorError("Accepted-only anchors must retain exact JPEG bytes", 409);
      anchors.push(image);
      receipts.push({ view_id: view.id, asset_id: asset.id, sha256: asset.sha256, bytes: asset.bytes, input_sha256: asset.view_dependency!.input_sha256,
        camera_sha256: viewHash(view.camera), source_sha256: sourceSha, review_sha256: viewHash(asset.keyframe.content_approval) });
      plan.keyframes[i] = { ...plan.keyframes[i]!, stage: "source", file: { key: asset.key, sha256: asset.sha256, bytes: asset.bytes } };
    }
    if (policy === ACCEPTED_ROUTE_POLICY && new Set(receipts.map(anchor => anchor.asset_id)).size !== views.length)
      throw new CreatorError("Each route camera needs its own reviewed artwork", 409);
    const fingerprint = viewHash(receipts);
    if (anchorsSha !== undefined && anchorsSha !== fingerprint) throw new CreatorError("The accepted anchors changed. Review the video quote.", 409);
    plan.duration = 5 * plan.legs.length;
    plan.legs.forEach(leg => { leg.seconds = 5; });
    plan.keyframes.forEach((frame, i) => { frame.time = round(i / plan.legs.length, 6); });
    return { plan, sha256, image: anchors[0]!, anchors, art: { key: scene.source_image_key, sha256: sourceSha }, size: views[0]!, place_id: pid, fence: views, worker: "path_video_views_v2",
      identity: { place_id: pid, view_ids: ids, views_sha256: sha256, keyframe_policy: policy, accepted_anchors_sha256: fingerprint, accepted_anchors: receipts } };
  }
  const plan = walkVideoPlan(views), accepted = views[0]!.accepted_illustration_id;
  const asset = accepted ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${accepted}`, session_id: sid }, options) : null;
  if (accepted && !asset) throw new CreatorError("Accepted artwork is unavailable", 409);
  const image = asset && { asset_id: asset.id, key: asset.key, sha256: asset.sha256, bytes: asset.bytes };
  // The accepted artwork is keyframe 0 as it is now.
  if (image) plan.keyframes[0]!.file = { key: image.key, sha256: image.sha256, bytes: image.bytes };
  return { plan, sha256, image, size: views[0]!, place_id: pid, fence: views, worker: "path_video_views_v2",
    identity: { place_id: pid, view_ids: ids, views_sha256: sha256 } };
}

async function acceptedWorkerAvailable(db: Db, policy: AcceptedPolicy, session?: ClientSession) {
  const options = session ? { session } : {}, fresh = { kind: "place-layout", motion_v1: true, last_seen: { $gt: new Date(Date.now() - 30_000) } };
  const capability = policy === ACCEPTED_ROUTE_POLICY ? "path_video_accepted_route" : "path_video_accepted_only";
  if (await db.collection("generation_workers").findOne({ ...fresh, [capability]: { $ne: true } }, options)) throw new CreatorError("Complete the reviewed-anchor video worker rollout before generating", 503);
  if (!await db.collection("generation_workers").findOne({ ...fresh, path_video_views_v2: true, [capability]: true }, options)) throw new CreatorError("Compatible reviewed-anchor video worker unavailable", 503);
}
async function pathVideoQuote(db: Db, sid: string, source: Source) {
  const { plan, image, size, worker } = source;
  if (acceptedPolicy(source.identity.keyframe_policy)) {
    if (!Number.isFinite(plan.duration) || plan.duration !== 5 * plan.legs.length || plan.duration > MAX_PATH_VIDEO_SECONDS || !plan.legs.length)
      throw new CreatorError("This reviewed route exceeds the supported video duration", 409);
    await acceptedWorkerAvailable(db, source.identity.keyframe_policy);
    const quote = await motionQuote(db, 5);
    if (quote.reservation !== .4) throw new CreatorError("The accepted-only five-second video price changed", 409);
    const reservation = round(.4 * plan.legs.length, 6);
    if (reservation > PATH_VIDEO_CAP_USD) throw new CreatorError("This reviewed route exceeds the path video spending cap", 409);
    return { reservation, expected_cost: reservation, retry_allowance: 0 as const, paid_keyframes: 0, appearance: false, source_prompt: "Accepted camera anchors",
      keyframe_reservation: 0, keyframe_parameters: {}, legs: plan.legs.map(() => ({ seconds: 5, duration: 5, reservation: .4 })) };
  }
  if (!Number.isFinite(plan.duration) || plan.duration <= 0 || plan.duration > MAX_PATH_VIDEO_SECONDS
    || plan.legs.some(leg => !Number.isFinite(leg.seconds) || leg.seconds <= 0 || leg.seconds > 15))
    throw new CreatorError("This path exceeds the supported video duration. Shorten it or add intermediate cameras.", 409);
  // /motion/leg reads the accepted source as leg 0's start: check it before any spend.
  if (image) {
    await motionSourceImage({ source: { image, view: size } });
    await reviewSource(db, sid, image);
  }
  const paid = plan.keyframes.filter(k => k.stage !== "source").length;
  const config = paid ? await assetBackend("illustration", "keyframe-capabilities") : { reservation: 0, parameters: {} };
  if (paid && (!config?.enabled || config.model !== KEYFRAME_MODEL || !Number.isFinite(config.reservation) || config.reservation <= 0 || !config.parameters))
    throw new CreatorError("Keyframe painting is not configured", 503);
  // An old backend refuses legs under its 5 s floor, after the keyframes are paid: size legs at the floor it advertises.
  const capabilities = await assetBackend("motion", "capabilities"), advertised = capabilities?.leg_min_seconds;
  const floor = Math.max(LEG_MIN_SECONDS, Number.isInteger(advertised) ? advertised : 5);
  if (plan.legs.some(leg => leg.move.lateral_m) && capabilities?.leg_move_version !== 2)
    throw new CreatorError("The backend does not support sideways camera movement. Update it before generating.", 503);
  const legs = plan.legs.map(leg => ({ seconds: leg.seconds, duration: legSeconds(leg.seconds, floor) })), costs = new Map<number, number>();
  if (legs.some(leg => leg.seconds + 1 / 24 < leg.duration * .5))
    throw new CreatorError("A camera span is too short for the backend's clip floor and bounded retiming. Use a longer span or an updated backend.", 409);
  for (const { duration } of legs) if (!costs.has(duration)) costs.set(duration, (await motionQuote(db, duration, floor)).reservation);
  if (!await db.collection("generation_workers").findOne({ kind: "place-layout", [worker]: true, last_seen: { $gt: new Date(Date.now() - 30_000) } }))
    throw new CreatorError("Compatible path video worker unavailable", 503);
  const micros = (n: number) => Math.round(n * 1_000_000);
  const expected_cost = (paid * micros(config.reservation) + legs.reduce((sum, leg) => sum + micros(costs.get(leg.duration)!), 0)) / 1_000_000;
  const reservation = round(expected_cost * 2, 6);
  if (reservation > PATH_VIDEO_CAP_USD) throw new CreatorError(`This path video needs $${reservation.toFixed(2)}, over the $${PATH_VIDEO_CAP_USD} cap. Shorten the path.`, 409);
  // Every keyframe is painted like a first one. When keyframe 0 is accepted
  // artwork, its own prompt is the appearance; otherwise the user words it.
  const artworkPrompt = image ? (await db.collection<MeshAssetDoc>("illustration_assets")
    .findOne({ _id: `${sid}:${image.asset_id}`, session_id: sid }))?.prompt.trim() ?? "" : "";
  const sourcePrompt = artworkPrompt.length >= 3 && artworkPrompt.length <= 1024 ? artworkPrompt : null;
  return { reservation, expected_cost, retry_allowance: 1 as const, paid_keyframes: paid, appearance: !sourcePrompt, source_prompt: sourcePrompt, keyframe_reservation: config.reservation as number, keyframe_parameters: config.parameters as Record<string, unknown>,
    legs: legs.map(leg => ({ ...leg, reservation: costs.get(leg.duration)! })) };
}
async function reviewSource(db: Db, sid: string, image: NonNullable<Source["image"]>, session?: ClientSession) {
  const options = session ? { session } : {}, assets = db.collection<MeshAssetDoc>("illustration_assets");
  const asset = await assets.findOne({ _id: `${sid}:${image.asset_id}`, session_id: sid }, options);
  if (!asset || asset.key !== image.key || asset.sha256 !== image.sha256 || !reviewedKeyframe(asset.keyframe, image.sha256))
    throw new CreatorError("The starting artwork needs verification and review of its final image. Saved videos remain playable.", 409);
  // Serialize paid source use with owner approval/artwork writes.
  if (session) await assets.updateOne({ _id: asset._id, sha256: image.sha256 }, { $inc: { source_use_fence: 1 } }, options);
}
async function fenceSource(db: Db, sid: string, source: Source, session: ClientSession) {
  if (source.anchors) {
    await acceptedWorkerAvailable(db, source.identity.keyframe_policy as AcceptedPolicy, session);
    for (const image of source.anchors) await reviewSource(db, sid, image, session);
  } else if (source.image) await reviewSource(db, sid, source.image, session);
  for (const view of source.fence) {
    await fenceViewSources(db, view, session);
    if (view.id) await db.collection<PlaceViewDoc>("place_views").updateOne({ _id: `${sid}:${view.id}`, session_id: sid }, { $inc: { source_use_fence: 1 } }, { session });
  }
}

// Release the unspent part of the reservation and close the job, once.
async function settle(db: Db, guard: Filter<PathVideoDoc>, status: "ready" | "failed" | "cancelled" | "needs_review", set: Partial<PathVideoDoc>) {
  return withDbTransaction(async (db, session) => {
    const col = db.collection<PathVideoDoc>("path_videos"), options = { session };
    const job = await col.findOne(guard, options);
    if (!job) return false;
    const unspent = job.funding_released ? 0 : round(job.reservation - job.committed, 6);
    if (unspent > 0) for (const id of job.ledger_ids) await db.collection<{ _id: string; total: number }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -unspent } }, options);
    await col.updateOne({ _id: job._id }, { $set: { status, funding_released: true, ...set } }, options);
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
      sources: (i: number) => assertCurrentView(db, views[i]!),
      span: (a: number, b: number) => {
        const { move, metres } = viewStep(views[a]!, views[b]!);
        return { move, far: metres > 2 * WALK_CHECKPOINT_METRES + 1e-6 || Math.abs(move.turn_deg) > 2 * CHECKPOINT_MAX_DEGREES + 1e-6 };
      } };
  }
  const study = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${job.session_id}:${job.study_id}`, session_id: job.session_id });
  if (!study || viewHash(study) !== job.study_sha256) return null;
  const path = study.preparation.path.keyframes, time = (i: number) => study.frames[i]!.time;
  return { size: study.source.view, source: study.source.image, passes: (i: number) => framePasses(study, i),
    chain: async (a: number) => ({ view: frameView(study, a), depth: await stored(study.files[a]!.depth) }),
    sources: async () => (await currentMotionStudy(db, job.session_id, study.id, job.study_sha256)).study.source.definitions,
    span: (a: number, b: number) => ({ move: legMove(path, time(a), time(b), job.subject),
      far: checkpointFar(sampleCameraPath(path, time(a)), sampleCameraPath(path, time(b)), 2) }) };
}

// One step of one job. Returns how long to wait before its next step.
async function step(db: Db, job: PathVideoDoc, token: string): Promise<number> {
  const col = db.collection<PathVideoDoc>("path_videos"), lease = { _id: job._id, work_token: token }, live = { ...lease, status: "running" as const };
  const save = async (set: Partial<PathVideoDoc>) => { if (!(await col.updateOne(live, { $set: set })).matchedCount) throw new Error("Path video lease lost"); };
  const pause = async (error: string, set: Partial<PathVideoDoc> = {}) => { await settle(db, live, "needs_review", { error, ...set }); return 0; };
  const frames = await jobFrames(db, job);
  if (!frames) return pause(job.view_ids ? "A saved view changed. Completed work was preserved." : "The motion study changed. Completed work was preserved.");
  const file = (name: string, ext: string, bytes: Buffer): MotionFile => ({ key: `${job.session_id}/path-videos/${job.id}/${name}-${hash(bytes)}.${ext}`, sha256: hash(bytes), bytes: bytes.length });
  // The last keyframe at or before index i that was not dropped (-1 for none).
  const kept = (i: number) => job.keyframes.slice(0, i + 1).findLastIndex(kf => !kf.dropped);
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
    let claimed: boolean;
    try {
      claimed = await withDbTransaction(async (db, session) => {
        const jobs = db.collection<PathVideoDoc>("path_videos"), options = { session };
        const fresh = await jobs.findOne({ ...live, work_until: { $gt: new Date(Date.now() + 120_000) } }, options);
        if (!fresh) return false;
        const source = await currentJobSource(db, job, session);
        await fenceSource(db, job.session_id, source, session);
        if (round(fresh.committed + attempt.cost, 6) > fresh.reservation) throw new CreatorError("The approved reservation is exhausted. Review a new quote.", 409);
        return !!(await jobs.updateOne(live, { $set: arrays(), $inc: { committed: attempt.cost } }, options)).matchedCount;
      });
    } catch (e) {
      if (e instanceof CreatorError) return pause(e.message);
      throw e;
    }
    if (!claimed) return 0;
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
  // Exactly one retry of a step, reserved on its own, on the job's scheduling day,
  // and recorded by `set` with the reservation. Returns why it was not reserved, or "".
  const reserveRetry = async (cost: number, set: Partial<PathVideoDoc>) => {
    try {
      if (job.retry_allowance !== 1) throw new CreatorError("no retry allowance was approved", 409);
      await withDbTransaction(async (db, session) => {
        const options = { session }, jobs = db.collection<PathVideoDoc>("path_videos");
        const fresh = await jobs.findOne(live, options);
        if (!fresh) throw new Error("Path video lease lost");
        if (round(fresh.committed + cost, 6) > fresh.reservation) throw new CreatorError("the approved retry ceiling is exhausted", 409);
        await jobs.updateOne(live, { $set: set }, options);
      });
      return "";
    } catch (e) {
      if (!(e instanceof CreatorError)) throw e;
      return `Retry not reserved: ${e.message}`;
    }
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
    if (acceptedPolicy(job.keyframe_policy)) return pause("An accepted anchor is missing. This policy never paints replacement artwork.");
    const kf = job.keyframes[k]!, arrays = () => ({ keyframes: job.keyframes, legs: job.legs });
    if (kf.stage === "source") {
      // The accepted study source image is keyframe 0; nothing is painted.
      // (A walk video pins view 0's accepted artwork when it is scheduled.)
      const { key, sha256, bytes } = frames.source!;
      await stored({ key, sha256, bytes });
      kf.file = { key, sha256, bytes }; await save(arrays()); return 0;
    }
    const p = kept(k - 1), prev = job.keyframes[p], attempt = kf.attempt;
    if (prev && !finalVerified(prev, job.verification_version)) return pause("The previous keyframe needs verification. Completed work was preserved.");
    // Keyframe i is chained from the last kept keyframe before it (its camera, depth pass and image).
    const captures = async () => ({ passes: await frames.passes(kf.frame),
      chain: prev ? { ...await frames.chain(prev.frame, kf.frame), image: await stored(prev.file) } as KeyframeChain : undefined });
    // Keep failed candidates as evidence; they never become automatic chain inputs.
    const iou = (t: KeyframeTry) => t.result!.candidates[t.result!.chosen]?.iou ?? -1;
    const keep = async (tries: KeyframeTry[]) => {
      const painted = tries.filter(t => t.file), best = painted.find(t => t.result!.passed) ?? painted.reduce((b, t) => iou(t) > iou(b) ? t : b);
      const other = tries.find(t => t !== best);
      Object.assign(kf, best, other ? { other } : {});
      if (!finalVerified(kf, job.verification_version))
        return pause(`Keyframe ${k + 1} did not pass verification. Completed work was preserved; review a quote to retry.`, arrays());
      await save(arrays()); return 0;
    };
    if (!attempt) {
      const sources = await frames.sources(kf.frame).catch(e => { if (e instanceof CreatorError) return null; throw e; });
      if (!sources) return pause("The geometry changed. Completed work was preserved.");
      const { passes, chain } = await captures(), prepared = await prepareKeyframeInput(passes, sources, job.art ? await stored(job.art) : null, chain);
      // A walk leg heads toward the object its end keyframe's gate measures (the most visible building, or object).
      if (job.view_ids && k > 0 && prepared.gate_object_id) job.legs[k - 1]!.move.subject = sources.flatMap(s => s.definition.objects).find(o => o.id === prepared.gate_object_id)?.label.slice(0, 120) ?? null;
      kf.attempt = { token: randomUUID(), cost: job.keyframe_reservation, status: "submitting" }; Object.assign(kf, { gate_object_id: prepared.gate_object_id, gate_subject: prepared.gate_subject });
      if (prev) kf.chained_from = p;
      return post(kf.attempt, arrays, KEYFRAME_MODEL, () => assetBackend("illustration", "submit", { prompt: job.prompt, model: KEYFRAME_MODEL,
        reservation: job.keyframe_reservation, parameters: job.keyframe_parameters, inputs: prepared.inputs }));
    }
    if (attempt.status === "submitting" || attempt.status === "submission_unknown") return halt(attempt, arrays);
    if (attempt.status === "failed" || attempt.status === "refused") {
      // A failed or refused retry leaves the first try to use.
      if (!kf.other) return pause("A keyframe was not painted. Completed work was preserved.", arrays());
      return keep([kf.other, { attempt }]);
    }
    const result = await poll(attempt, arrays, `requests/${encodeURIComponent(attempt.request_id!)}?model=${encodeURIComponent(KEYFRAME_MODEL)}`, "illustration");
    if (typeof result === "number") return result;
    const urls = ((result.images ?? [result.image]) as { url?: unknown }[]).map(image => meshDownloadUrl(image?.url)), { passes, chain } = await captures();
    // The gate runs at most once: "started" is saved before the call, the
    // result before any download, and a "started" found later is an outage.
    if (!kf.gate) {
      kf.gate = { status: "started" }; await save(arrays());
      const body = await keyframeGateBody(passes, kf.gate_object_id ?? null, urls, kf.gate_subject?.label);
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
    const png = bytes[0] === 0x89, saved = file(`keyframe${k}`, png ? "png" : "jpg", bytes);
    await uploadJpeg(saved.key, bytes, png ? "image/png" : "image/jpeg", AbortSignal.timeout(90_000));
    // A passing gate is the acceptance. A failed gate is painted once more,
    // reserved like a leg retry, with the first try waiting in `other`; then
    // the better try is kept, flagged.
    attempt.status = "ready";
    const tried: KeyframeTry = { attempt, gate: kf.gate, result: painted, file: saved };
    if (painted.gate === "failed" && !kf.retry) {
      const { attempt: _attempt, gate: _gate, ...rest } = kf;
      const why = await reserveRetry(job.keyframe_reservation, { keyframes: job.keyframes.map((item, i) => i === k ? { ...rest, other: tried, retry: "reserved" } : item) });
      if (!why) return 0;
      kf.retry = why;
    }
    return keep(kf.other ? [kf.other, tried] : [tried]);
  }

  const l = job.legs.findIndex(leg => leg.chosen === undefined && !leg.dropped);
  if (l >= 0) {
    // A leg after a dropped keyframe starts at the last kept one.
    const leg = job.legs[l]!, arrays = () => ({ legs: job.legs }), from = job.keyframes[kept(l)]!, to = job.keyframes[l + 1]!;
    if (!finalVerified(from, job.verification_version) || !finalVerified(to, job.verification_version))
      return pause("A leg endpoint needs verification. Completed work was preserved.");
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
    if ((last.status === "failed" || last.status === "refused") && leg.attempts.length === 1) return pause("A leg was not made. Completed work was preserved.", arrays());
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
      const timing = Math.abs(endAt * factor - leg.seconds) <= 1 / fps + 1e-6;
      Object.assign(last, { status: "ready", metrics: { end: round(endAt, 3), land: round(check.land, 3), snap: round(check.snap, 3), ok: check.ok && timing, timing, factor: round(factor, 3) } });
      await save(arrays());
    }
    if (leg.attempts.length === 1 && !leg.retry && !last.metrics!.ok) {
      const why = await reserveRetry(leg.cost, { legs: job.legs.map((item, i) => i === l ? { ...item, retry: "reserved" } : item) });
      if (!why) return 0;
      leg.retry = why;
    }
    // A non-landing attempt is evidence, never a finished route.
    const measured = leg.attempts.flatMap((a, i) => a.metrics ? [{ i, ...a.metrics }] : []);
    const best = measured.find(a => a.ok) ?? measured.reduce((b, a) => a.land < b.land ? a : b);
    if (!best.ok) return pause(`Leg ${l + 1} did not meet landing or timing checks${job.retry_allowance === 0 ? "; no paid retry was approved" : " after its bounded retry"}. Completed work was preserved.`, arrays());
    Object.assign(leg, { chosen: best.i, landed: true }); await save(arrays()); return 0;
  }

  if (job.keyframes.some(kf => kf.dropped || !finalVerified(kf, job.verification_version)) || job.legs.some(leg => leg.dropped || !leg.landed))
    return pause("The route is incomplete. Completed work was preserved.");
  const cuts: Buffer[] = [];
  for (const [i, leg] of job.legs.entries()) if (!leg.dropped) {
    const chosen = leg.attempts[leg.chosen!]!; let cut = await verified(chosen.cut);
    if (!cut) {
      // Derivatives can be reconstructed locally from a verified original.
      const raw = await stored(chosen.original), { fps, deltas, frames: decoded } = await legMotion(raw);
      const end = motionEnd(deltas, fps) || decoded.length / fps, factor = Math.min(2, Math.max(.5, leg.seconds / end));
      if (Math.abs(end * factor - leg.seconds) > 1 / fps + 1e-6) return pause("A leg cannot fit the planned duration. Completed work was preserved.");
      cut = await cutLeg(raw, end, factor, { width: frames.size.width, height: frames.size.height });
      chosen.cut = file(`leg${i}-${leg.chosen}-cut`, "mp4", cut);
      await uploadJpeg(chosen.cut.key, cut, "video/mp4", AbortSignal.timeout(90_000)); await save({ legs: job.legs });
    }
    cuts.push(cut);
  }
  if (!cuts.length) return pause("The route has no verified legs. Completed work was preserved.");
  const { bytes, media } = await joinLegs(cuts, job.duration), video = file("video", "mp4", bytes);
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
  if (errors >= 20 && !unread) await settle(db, live, "needs_review", { error: "Path video storage or provider stayed unavailable. Completed work was preserved and unspent reservation released." });
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
  if (!isSafeId(id)) throw new CreatorError(`Invalid ${kind} id`, 400);
  return requireCreator(sid);
}
const wire = (job: PathVideoDoc) => ({ id: job.id, status: job.status, reservation: job.reservation, committed: job.committed,
  ...(job.keyframe_policy ? { keyframe_policy: job.keyframe_policy, accepted_anchors_sha256: job.accepted_anchors_sha256 } : {}),
  ...(job.archive_provenance ? { archive_provenance: job.archive_provenance } : {}),
  created_at: job.created_at.toISOString(), ...(job.error ? { error: job.error } : {}), ...(job.media ? { media: job.media } : {}),
  keyframes: job.keyframes.map(kf => ({ time: kf.time, stage: kf.stage, status: kf.file ? "ready" : kf.attempt?.status ?? "waiting",
    preview: !!kf.file, sha256: kf.file?.sha256 ?? null,
    ...(kf.result ? { gate: kf.result.gate, passed: kf.result.passed } : {}), ...(kf.retry ? { retry: kf.retry } : {}),
    ...(kf.dropped ? { dropped: true, drop_reason: kf.drop_reason } : {}), ...(kf.kept_reason ? { kept_reason: kf.kept_reason } : {}) })),
  legs: job.legs.map(leg => ({ seconds: leg.seconds, duration: leg.duration, ...(leg.landed === undefined ? {} : { landed: leg.landed }), ...(leg.dropped ? { dropped: true } : {}),
    attempts: leg.attempts.map(a => ({ status: a.status, ...(a.metrics ? { land: a.metrics.land, snap: a.metrics.snap, ok: a.metrics.ok } : {}) })) })) });
const finalVerified = (kf: PathVideoKeyframe, version?: number) => kf.stage === "source" && !!kf.file || !!kf.file && !!kf.result
  && (version === 2 ? verifiedKeyframe({ version: 1, object_id: kf.gate_object_id ?? null, stage: kf.stage === "chain" ? "chain" : "first", ...kf.result }, kf.file.sha256)
    : kf.result.gate === "passed" && kf.result.passed);
async function currentJobSource(db: Db, job: PathVideoDoc, session?: ClientSession): Promise<Source> {
  if (job.view_ids) {
    if (acceptedPolicy(job.keyframe_policy)) {
      const count = job.accepted_anchors?.length ?? 0;
      if (!/^[a-f0-9]{64}$/.test(job.accepted_anchors_sha256 ?? "") || count < 2 || count > MAX_CHECKPOINTS
        || job.keyframe_policy === ACCEPTED_ONLY_POLICY && count !== 2
        || job.retry_allowance !== 0 || job.keyframe_reservation !== 0 || job.duration !== 5 * (count - 1) || job.duration > MAX_PATH_VIDEO_SECONDS
        || job.legs.length !== count - 1 || job.legs.some(leg => leg.duration !== 5 || leg.seconds !== 5 || leg.cost !== .4 || leg.dropped)
        || job.keyframes.length !== count || job.view_ids.length !== count
        || job.keyframes.some((frame, i) => frame.stage !== "source" || frame.frame !== i || frame.time !== round(i / (count - 1), 6) || frame.dropped
          || frame.file?.sha256 !== job.accepted_anchors![i]!.sha256 || frame.file.bytes !== job.accepted_anchors![i]!.bytes || job.view_ids![i] !== job.accepted_anchors![i]!.view_id)
        || job.keyframe_policy === ACCEPTED_ROUTE_POLICY && (job.keyframes.some(frame => frame.attempt || frame.other || frame.chained_from !== undefined)
          || job.legs.some(leg => leg.attempts.length > 1 || leg.attempts.some(attempt => attempt.cost !== .4)))
        || viewHash(job.accepted_anchors) !== job.accepted_anchors_sha256) throw new CreatorError("The accepted-only video receipt changed", 409);
    }
    const source = await walkSource(db, job.session_id, job.place_id!, job.view_ids, job.views_sha256, session, job.keyframe_policy, job.accepted_anchors_sha256);
    if (acceptedPolicy(job.keyframe_policy) && job.keyframes.some((frame, i) => frame.file!.key !== source.plan.keyframes[i]!.file!.key)) throw new CreatorError("The accepted anchor storage binding changed", 409);
    return source;
  }
  const { study, view } = await currentMotionStudy(db, job.session_id, job.study_id!, job.study_sha256, session);
  return studySource(study, view);
}
const resumeStart = (job: PathVideoDoc) => {
  const frame = job.keyframes.findIndex(kf => kf.dropped || !finalVerified(kf, 2));
  const unfinished = job.legs.findIndex(item => item.dropped || !item.landed);
  const leg = frame >= 0 ? Math.min(Math.max(0, frame - 1), unfinished < 0 ? job.legs.length : unfinished) : unfinished;
  return { frame, leg };
};
const resumeHash = (job: PathVideoDoc) => viewHash({ status: job.status, committed: job.committed,
  ...(job.keyframe_policy ? { keyframe_policy: job.keyframe_policy, accepted_anchors_sha256: job.accepted_anchors_sha256, accepted_anchors: job.accepted_anchors } : {}),
  keyframes: job.keyframes, legs: job.legs, resumes: job.resume_history?.map(r => r.id) ?? [] });
interface ResumeWire { reservation: number; expected_cost: number; retry_allowance: 0 | 1; source_sha256: string; job_sha256: string; storage_only: boolean; accepted_anchors_sha256?: string }
async function resumeQuote(db: Db, job: PathVideoDoc) {
  if (job.archive_provenance) throw new CreatorError("Archived videos are playback records. Capture a new path to generate.", 409);
  if (acceptedPolicy(job.keyframe_policy)) {
    const source = await currentJobSource(db, job);
    for (const leg of job.legs) {
      const chosen = leg.attempts[leg.chosen ?? -1];
      if (!leg.landed || leg.dropped || !chosen || !(await verified(chosen.cut) || await verified(chosen.original)))
        throw new CreatorError("Accepted-only video has no paid retry allowance. The original work remains preserved.", 409);
    }
    const quote = { reservation: 0, expected_cost: 0, retry_allowance: 0 as const, paid_keyframes: 0, appearance: false, source_prompt: null,
      keyframe_reservation: 0, keyframe_parameters: {}, legs: [] };
    return { source, start: { frame: -1, leg: -1 }, quote, leg_indices: [] as number[], storage_only: true,
      wire: { reservation: 0, expected_cost: 0, retry_allowance: 0, source_sha256: source.sha256, job_sha256: resumeHash(job), storage_only: true,
        accepted_anchors_sha256: job.accepted_anchors_sha256! } as ResumeWire };
  }
  let start = resumeStart(job);
  const reusableLegs: boolean[] = [];
  for (const [i, leg] of job.legs.entries()) {
    const chosen = leg.attempts[leg.chosen ?? -1];
    const reusable = !!leg.landed && !leg.dropped && !!chosen && (!!await verified(chosen.cut) || !!await verified(chosen.original));
    reusableLegs.push(reusable);
    if (!reusable && (start.leg < 0 || i < start.leg)) start = { ...start, leg: i };
  }
  // A receipt cannot reuse bytes that storage no longer has. Repaint only the
  // first unavailable generated checkpoint and its dependents, with consent.
  for (let i = 0; i < job.keyframes.length && (start.frame < 0 || i < start.frame); i++) {
    if (await verified(job.keyframes[i]!.file)) continue;
    const affected = Math.max(0, i - 1);
    start = { frame: i, leg: start.leg < 0 ? affected : Math.min(start.leg, affected) }; break;
  }
  if (start.frame < 0 && start.leg < 0) {
    const frames = await jobFrames(db, job);
    if (!frames) throw new CreatorError("Saved camera captures need storage recovery", 409);
    const source: Source = { plan: { duration: job.duration, subject: job.subject, keyframes: job.keyframes, legs: job.legs },
      sha256: job.study_sha256 ?? job.views_sha256!, image: null, size: frames.size, place_id: job.place_id ?? "", fence: [], identity: {}, worker: "path_video_v2" };
    const quote = { reservation: 0, expected_cost: 0, retry_allowance: 1 as const, paid_keyframes: 0, appearance: false, source_prompt: null,
      keyframe_reservation: job.keyframe_reservation, keyframe_parameters: job.keyframe_parameters, legs: [] };
    return { source, start, quote, leg_indices: [] as number[], storage_only: true, wire: { reservation: 0, expected_cost: 0, retry_allowance: 1 as const,
      source_sha256: source.sha256, job_sha256: resumeHash(job), storage_only: true } as ResumeWire };
  }
  if (process.env.PATH_VIDEO_ENABLED !== "1") throw new CreatorError("New generation is disabled", 409);
  const source = await currentJobSource(db, job);
  const leg_indices = source.plan.legs.flatMap((_leg, i) => i >= start.leg && (start.frame >= 0 || !reusableLegs[i]) ? [i] : []);
  const remaining = { ...source, plan: { ...source.plan,
    keyframes: source.plan.keyframes.map((frame, i) => i < start.frame || start.frame < 0 ? { ...frame, stage: "source" as const } : frame),
    legs: source.plan.legs.filter((_leg, i) => leg_indices.includes(i)) } };
  const quote = await pathVideoQuote(db, job.session_id, remaining);
  return { source, start, quote, leg_indices, storage_only: false, wire: { reservation: quote.reservation, expected_cost: quote.expected_cost, retry_allowance: quote.retry_allowance,
    source_sha256: source.sha256, job_sha256: resumeHash(job), storage_only: false } as ResumeWire };
}
async function jobList(db: Db, sid: string, scope: Scope) {
  const jobs = await db.collection<PathVideoDoc>("path_videos").find({ session_id: sid, ...scope }).sort({ created_at: -1 }).limit(20).toArray();
  return Promise.all(jobs.map(async job => {
    if (job.status !== "needs_review") return { ...wire(job), resume_quote: null as Awaited<ReturnType<typeof resumeQuote>>["wire"] | null, resume_reason: "" };
    try { return { ...wire(job), resume_quote: (await resumeQuote(db, job)).wire, resume_reason: "" }; }
    catch (e) { return { ...wire(job), resume_quote: null, resume_reason: e instanceof CreatorError ? e.message : "Resume quote unavailable" }; }
  }));
}
// A source's checkpoints and quote, or why it cannot make a video.
async function priced(db: Db, sid: string, load: () => Promise<Source>) {
  let sha256 = "", accepted_anchors_sha256: string | null = null, checkpoints = 0, quote: Omit<Awaited<ReturnType<typeof pathVideoQuote>>, "keyframe_parameters" | "source_prompt"> | null = null, reason = "";
  try {
    if (process.env.PATH_VIDEO_ENABLED !== "1") throw new CreatorError("New generation is disabled", 409);
    const source = await load(); sha256 = source.sha256; accepted_anchors_sha256 = source.identity.accepted_anchors_sha256 ?? null; checkpoints = source.plan.keyframes.length;
    const { keyframe_parameters: _parameters, source_prompt: _prompt, ...rest } = await pathVideoQuote(db, sid, source); quote = rest;
  } catch (e) { reason = e instanceof CreatorError ? e.message : "Path video backend unavailable"; }
  return { sha256, accepted_anchors_sha256, checkpoints, quote, reason };
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
export async function walkVideoLibrary(sid: string, pid: string, viewIds: string[] | null, policy?: unknown) {
  const db = await access(sid, pid, "place"), jobs = await jobList(db, sid, { place_id: pid });
  if (policy !== undefined && !acceptedPolicy(policy)) throw new CreatorError("Unknown walk video keyframe policy", 400);
  const { sha256, ...rest } = viewIds ? await priced(db, sid, () => walkSource(db, sid, pid, viewIds, undefined, undefined, policy)) : { sha256: "", accepted_anchors_sha256: null, checkpoints: 0, quote: null, reason: "" };
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
  if (process.env.PATH_VIDEO_ENABLED !== "1") throw new CreatorError("New generation is disabled", 409);
  const source = await load(db), { plan } = source, quote = await pathVideoQuote(db, sid, source);
  if (input.reservation !== quote.reservation) throw new CreatorError("Path video price changed. Review the reservation.", 409);
  const prompt = quote.source_prompt ?? (typeof input.prompt === "string" ? input.prompt.trim() : "");
  if (prompt.length < 3 || prompt.length > 1024) throw new CreatorError("An appearance prompt is required", 400);
  // Chains send the world's art too (words only for a world without art), so their holes are painted, not restyled.
  const art = source.anchors ? source.art ?? null : await keyframeArt(db, sid, source.place_id);
  return withDbTransaction(async (db, session) => {
    const options = { session }, jobs = db.collection<PathVideoDoc>("path_videos");
    const old = await jobs.findOne({ _id: key }, options); if (old) return same(old);
    const freshSource = await load(db, session);
    // Failed and cancelled jobs do not count: they would lock the source out for good.
    if (await jobs.countDocuments({ session_id: sid, ...scope, status: { $in: [...ACTIVE, "ready"] } }, options) >= 20) throw new CreatorError("place_id" in scope ? "This place already has 20 walk videos" : "Motion study already has 20 path videos", 409);
    await fenceSource(db, sid, freshSource, session);
    // The ledger day of the full estimate; a leg retry reserves on the same day.
    const now = new Date(), ledger_ids = await reserveGenerationSpend(db, session, sid, "motion", quote.reservation, "MOTION_DAILY_CAP_USD", now, "3");
    const job: PathVideoDoc = { _id: key, id, session_id: sid, ...source.identity,
      request_sha256: requestHash, created_at: now, status: "scheduled", prompt, reservation: quote.reservation, committed: 0, ledger_ids,
      verification_version: 2, retry_allowance: quote.retry_allowance, funding_released: false,
      keyframe_reservation: quote.keyframe_reservation, keyframe_parameters: quote.keyframe_parameters, art, duration: plan.duration, subject: plan.subject,
      keyframes: plan.keyframes, legs: plan.legs.map((leg, i) => ({ ...leg, duration: quote.legs[i]!.duration, cost: quote.legs[i]!.reservation, attempts: [] })) };
    await jobs.insertOne(job, options); return { job: wire(job) };
  });
}
async function cancel(db: Db, sid: string, scope: Scope, input: Record<string, unknown>) {
  if (input.action !== "cancel" || !isSafeId(input.id)) throw new CreatorError("Invalid path video action", 400);
  const guard = { _id: `${sid}:${input.id}`, session_id: sid, ...scope };
  if (await settle(db, { ...guard, status: { $in: [...ACTIVE, "needs_review"] } }, "cancelled", { error: "Cancelled. Unspent reservation released; steps already sent may remain billable." })) return { saved: true };
  const job = await db.collection<PathVideoDoc>("path_videos").findOne(guard);
  if (!job) throw new CreatorError("Path video missing", 404);
  if (job.status !== "cancelled") throw new CreatorError("Path video already finished", 409);
  return { saved: true };
}
async function resume(db: Db, sid: string, scope: Scope, input: Record<string, unknown>) {
  if (!isSafeId(input.id) || !isSafeId(input.request_id) || input.confirmed !== true || typeof input.job_sha256 !== "string" || typeof input.source_sha256 !== "string")
    throw new CreatorError("Explicit priced resume consent is required", 400);
  const id = input.request_id, guard = { _id: `${sid}:${input.id}`, session_id: sid, ...scope }, requestHash = viewHash(input);
  const previous = await db.collection<PathVideoDoc>("path_videos").findOne(guard);
  if (!previous) throw new CreatorError("Path video missing", 404);
  const same = (job: PathVideoDoc) => {
    const receipt = job.resume_history?.find(r => r.id === id);
    if (!receipt) return null;
    if (receipt.request_sha256 !== requestHash) throw new CreatorError("Resume request identity already used", 409);
    return { job: wire(job) };
  };
  const prior = same(previous); if (prior) return prior;
  if (previous.status !== "needs_review") throw new CreatorError("This path video is not paused for review", 409);
  if ((previous.resume_history?.length ?? 0) >= 20) throw new CreatorError("This video has reached its resume limit", 409);
  const prepared = await resumeQuote(db, previous);
  if (input.reservation !== prepared.wire.reservation || input.source_sha256 !== prepared.wire.source_sha256 || input.job_sha256 !== prepared.wire.job_sha256)
    throw new CreatorError("The resume price or source changed. Review a new quote.", 409);
  if (acceptedPolicy(previous.keyframe_policy) && input.accepted_anchors_sha256 !== prepared.wire.accepted_anchors_sha256) throw new CreatorError("The accepted anchors changed", 409);
  return withDbTransaction(async (db, session) => {
    const jobs = db.collection<PathVideoDoc>("path_videos"), options = { session }, job = await jobs.findOne(guard, options);
    if (!job) throw new CreatorError("Path video missing", 404);
    const prior = same(job); if (prior) return prior;
    if (job.status !== "needs_review" || resumeHash(job) !== input.job_sha256) throw new CreatorError("The paused video changed", 409);
    const source = prepared.storage_only && !acceptedPolicy(job.keyframe_policy) ? prepared.source : await currentJobSource(db, job, session);
    if (source.sha256 !== input.source_sha256) throw new CreatorError("The video source changed", 409);
    if (acceptedPolicy(job.keyframe_policy) && source.identity.accepted_anchors_sha256 !== input.accepted_anchors_sha256) throw new CreatorError("The accepted anchors changed", 409);
    await fenceSource(db, sid, source, session);
    const now = new Date(), ledger_ids = prepared.storage_only ? [] : await reserveGenerationSpend(db, session, sid, "motion", prepared.quote.reservation, "MOTION_DAILY_CAP_USD", now, "3");
    const history = [...job.resume_history ?? [], { id, request_sha256: requestHash, created_at: now,
      reservation: prepared.quote.reservation, keyframes: job.keyframes, legs: job.legs }];
    const { frame } = prepared.start;
    const keyframes = job.keyframes.map((kf, i) => frame >= 0 && i >= frame ? { ...source.plan.keyframes[i]! } : kf);
    const legs = job.legs.map((old, i) => { const quoted = prepared.leg_indices.indexOf(i); return quoted >= 0 ? { ...source.plan.legs[i]!,
      duration: prepared.quote.legs[quoted]!.duration, cost: prepared.quote.legs[quoted]!.reservation, attempts: [] } : old; });
    await jobs.updateOne({ ...guard, status: "needs_review" }, { $set: { status: "scheduled", keyframes, legs, ledger_ids,
      verification_version: 2, retry_allowance: prepared.quote.retry_allowance, funding_released: false, reservation: round(job.committed + prepared.quote.reservation, 6),
      keyframe_reservation: prepared.quote.paid_keyframes ? prepared.quote.keyframe_reservation : job.keyframe_reservation,
      keyframe_parameters: prepared.quote.paid_keyframes ? prepared.quote.keyframe_parameters : job.keyframe_parameters, resume_history: history,
      errors: 0, next_check: now }, $unset: { error: "", work_token: "", work_until: "" } }, options);
    return { job: wire((await jobs.findOne(guard, options))!) };
  });
}
export async function pathVideoAction(sid: string, studyId: string, input: Record<string, unknown>) {
  if (input.keyframe_policy !== undefined || input.accepted_anchors_sha256 !== undefined) throw new CreatorError("Accepted-only policy applies to saved walk cameras", 400);
  const db = await access(sid, studyId), sha = input.study_sha256;
  if (input.action === "resume") return resume(db, sid, { study_id: studyId }, input);
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
  if (input.action === "resume") return resume(db, sid, { place_id: pid }, input);
  if (input.action !== "generate") return cancel(db, sid, { place_id: pid }, input);
  if (typeof input.views_sha256 !== "string") throw new CreatorError("Explicit priced consent is required", 400);
  if (acceptedPolicy(input.keyframe_policy) ? !/^[a-f0-9]{64}$/.test(String(input.accepted_anchors_sha256 ?? "")) : input.accepted_anchors_sha256 !== undefined) throw new CreatorError("Explicit accepted-anchor consent is required", 400);
  return schedule(db, sid, input, { place_id: pid }, (db, session) => walkSource(db, sid, pid, input.view_ids, input.views_sha256, session, input.keyframe_policy, input.accepted_anchors_sha256));
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
async function keyframeBytes(db: Db, sid: string, scope: Scope, id: string, index: string) {
  if (!isSafeId(id) || !/^(0|[1-9]\d?)$/.test(index) || Number(index) >= MAX_CHECKPOINTS) throw new CreatorError("Invalid keyframe identity", 400);
  const job = await db.collection<PathVideoDoc>("path_videos").findOne({ _id: `${sid}:${id}`, session_id: sid, ...scope });
  const file = job?.keyframes[Number(index)]?.file;
  if (!file) throw new CreatorError("Preserved keyframe not found", 404);
  const bytes = await verified(file); if (!bytes) throw new CreatorError("Preserved keyframe is unavailable or corrupted", 503);
  return { bytes, content_type: bytes[0] === 0x89 ? "image/png" : "image/jpeg" };
}
export const pathVideoKeyframeBytes = async (sid: string, studyId: string, id: string, index: string) => keyframeBytes(await access(sid, studyId), sid, { study_id: studyId }, id, index);
export const walkVideoKeyframeBytes = async (sid: string, pid: string, id: string, index: string) => keyframeBytes(await access(sid, pid, "place"), sid, { place_id: pid }, id, index);
