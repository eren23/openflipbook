import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { withDbTransaction } from "./db";
import { placeScenesEnabled } from "./place-scene-enabled";
import { assertCurrentView, fenceViewSources, viewHash, type PlaceViewDoc } from "./place-view-store";
import { parseCaptureMetadata, decodeViewPasses, wirePlaceView } from "./place-view-server";
import { prepareOwnedCameraMotion } from "./camera-motion-server";
import { measureMotionLandmarks } from "./camera-motion-reference";
import { getStoredBytes, uploadJpeg } from "./r2";
import { VIEW_PASSES, type ViewPass } from "./place-view";
import type { MeshAssetDoc } from "./mesh-execution";
import type { MotionStudy, MotionStudyDoc } from "./motion-study";
import type { CameraPathCheck } from "./camera-path";

const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const wire = (doc: MotionStudyDoc, historical: boolean): MotionStudy => ({ id: doc.id, label: doc.label, view_id: doc.view_id,
  created_at: doc.created_at, preparation_sha256: doc.preparation_sha256, historical, status: doc.status,
  provenance: doc.provenance, preflight: doc.preflight, client_preflight: doc.client_preflight ?? null, frames: doc.frames });
export function reportedPreflight(value: unknown): CameraPathCheck | null {
  // Retain diagnostic failures, but a client report never authorizes generation.
  // Earlier studies omitted this report; missing evidence is not a clear path.
  if (value == null) return null;
  if (typeof value !== "object") throw new CreatorError("Invalid reported preflight", 400);
  const report = value as CameraPathCheck;
  if (!["clear", "blocked"].includes(report.status) || !Number.isInteger(report.samples) || report.samples < 2 || report.samples > 4097
    || !Number.isFinite(report.clearance) || report.clearance < 0.2 || report.clearance > 5
    || !["sampled", "not_requested"].includes(report.visibility) || !Array.isArray(report.issues) || report.issues.length > 32
    || (report.status === "clear") !== (report.issues.length === 0)
    || report.issues.some(issue => !issue || !["collision", "occluded"].includes(issue.kind)
      || !Number.isFinite(issue.time) || !Number.isFinite(issue.end_time) || issue.time < 0 || issue.end_time > 1 || issue.time >= issue.end_time))
    throw new CreatorError("Invalid reported preflight", 400);
  return { status: report.status, samples: report.samples, clearance: report.clearance, visibility: report.visibility,
    issues: report.issues.map(({ kind, time, end_time }) => ({ kind, time, end_time })) };
}
async function access(sid: string, id: string) {
  if (!isSafeId(sid) || !isSafeId(id)) throw new CreatorError("Invalid motion study identity", 400);
  return requireCreator(sid);
}
export async function motionStudyLibrary(sid: string, viewId: string) {
  const db = await access(sid, viewId);
  const docs = await db.collection<MotionStudyDoc>("motion_studies").find({ session_id: sid, view_id: viewId }).sort({ created_at: -1 }).limit(20).toArray();
  let current: string | null = null;
  try { current = (await prepareOwnedCameraMotion(db, sid, viewId)).preparation_sha256; }
  catch (error) { if (!(error instanceof CreatorError) || ![400, 404, 409].includes(error.status)) throw error; }
  return { studies: docs.map(doc => wire(doc, doc.preparation_sha256 !== current)) };
}

export async function saveMotionStudy(sid: string, viewId: string, input: Record<string, unknown>) {
  const db = await access(sid, viewId);
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(input.id) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 120
    || typeof input.preparation_sha256 !== "string") throw new CreatorError("Invalid motion study request", 400);
  const id = input.id, key = `${sid}:${id}`, requestHash = viewHash(input);
  const same = (doc: MotionStudyDoc) => {
    if (doc.view_id !== viewId || doc.request_sha256 !== requestHash) throw new CreatorError("Motion study identity already used", 409);
    return { id: doc.id };
  };
  const prior = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: key, session_id: sid });
  if (prior) return same(prior);
  const clientPreflight = reportedPreflight(input.client_preflight);
  const prepared = await prepareOwnedCameraMotion(db, sid, viewId);
  if (input.preparation_sha256 !== prepared.preparation_sha256) throw new CreatorError("Motion preparation changed", 409);
  if (!Array.isArray(input.frames) || input.frames.length !== prepared.reference_cameras.length) throw new CreatorError("Motion reference frames are incomplete", 400);
  if (await db.collection<MotionStudyDoc>("motion_studies").countDocuments({ session_id: sid, view_id: viewId }) >= 20) throw new CreatorError("This view already has 20 motion studies", 409);
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${viewId}`, session_id: sid });
  if (!view) throw new CreatorError("Saved view unavailable", 409);
  const definitions = await assertCurrentView(db, view);
  const assetId = prepared.source.image.asset_id;
  if ((view.accepted_illustration_id ?? null) !== assetId) throw new CreatorError("Accepted motion artwork changed", 409);
  const asset = assetId ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${assetId}`, session_id: sid }) : null;
  const image = asset ?? view.files.render;
  if (assetId && !asset || image.sha256 !== prepared.source.image.sha256) throw new CreatorError("Motion source image changed", 409);
  const sourceBytes = await getStoredBytes(image.key, AbortSignal.timeout(30_000));
  if (!sourceBytes || sourceBytes.bytes.length !== image.bytes || bytesHash(sourceBytes.bytes) !== image.sha256) throw new CreatorError("Motion source bytes unavailable or corrupted", 503);
  const frames: MotionStudyDoc["frames"] = [], files: MotionStudyDoc["files"] = [];
  const decodedFrames: Awaited<ReturnType<typeof decodeViewPasses>>[] = [];
  let totalBytes = sourceBytes.bytes.length;
  for (const [index, raw] of input.frames.entries()) {
    const expected = prepared.reference_cameras[index]!;
    if (!raw || raw.time !== expected.time || raw.seconds !== expected.seconds) throw new CreatorError("Motion reference timing differs", 400);
    const capture = parseCaptureMetadata(raw.capture);
    const closeMatrix = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]!) <= 1e-10 * Math.max(1, Math.abs(n), Math.abs(b[i]!)));
    if (capture.mode !== "orbit" || capture.floor_id !== null || capture.path || capture.width !== view.width || capture.height !== view.height
      || !isDeepStrictEqual(capture.sources, definitions) || !isDeepStrictEqual(capture.objects, view.objects)
      || capture.camera.near !== view.camera.near || capture.camera.far !== view.camera.far
      || !closeMatrix(capture.camera.world_matrix, expected.world_matrix) || !isDeepStrictEqual(capture.camera.projection_matrix, expected.projection_matrix))
      throw new CreatorError("Motion reference does not match its prepared geometry and camera", 409);
    const decoded = await decodeViewPasses(capture);
    totalBytes += VIEW_PASSES.reduce((sum, pass) => sum + decoded[pass].length, 0);
    if (totalBytes > 48 * 1024 * 1024) throw new CreatorError("Motion study exceeds 48 MiB", 413);
    decodedFrames.push(decoded);
    const rgba = await sharp(decoded.objects).ensureAlpha().raw().toBuffer();
    frames.push({ time: expected.time, seconds: expected.seconds, camera: capture.camera,
      measurements: measureMotionLandmarks(rgba, capture.width, capture.height, capture.objects) });
  }
  for (const [index, decoded] of decodedFrames.entries()) {
    const frameFiles = {} as MotionStudyDoc["files"][number];
    for (const pass of VIEW_PASSES) {
      const bytes = decoded[pass], sha256 = bytesHash(bytes), path = `${sid}/motion/${id}/${index}-${pass}-${sha256}.png`;
      await uploadJpeg(path, bytes, "image/png", AbortSignal.timeout(90_000));
      frameFiles[pass] = { key: path, sha256, bytes: bytes.length };
    }
    files.push(frameFiles);
  }
  const { source: _source, preparation_sha256: _sha, generation_enabled: _enabled, status: _status, ...preparation } = prepared;
  const doc: MotionStudyDoc = { _id: key, id, session_id: sid, view_id: viewId, label: input.label.trim(), request_sha256: requestHash,
    preparation_sha256: prepared.preparation_sha256, created_at: new Date().toISOString(), status: "reference_only",
    provenance: "client_rendered_saved_geometry", preflight: "not_server_attested", client_preflight: clientPreflight, frames, files, preparation,
    source: { view: wirePlaceView(view, false), definitions, image: { asset_id: assetId, key: image.key, sha256: image.sha256, bytes: image.bytes } } };
  return withDbTransaction(async (db, session) => {
    const col = db.collection<MotionStudyDoc>("motion_studies"), options = { session };
    const existing = await col.findOne({ _id: key, session_id: sid }, options); if (existing) return same(existing);
    if ((await prepareOwnedCameraMotion(db, sid, viewId, session)).preparation_sha256 !== prepared.preparation_sha256) throw new CreatorError("Motion sources changed during storage", 409);
    if (await col.countDocuments({ session_id: sid, view_id: viewId }, options) >= 20) throw new CreatorError("Motion study limit reached", 409);
    await fenceViewSources(db, view, session);
    await col.insertOne(doc, options); return { id };
  });
}

export async function motionStudyFrame(sid: string, studyId: string, index: number, pass: ViewPass) {
  const db = await access(sid, studyId);
  if (!Number.isInteger(index) || index < 0 || !VIEW_PASSES.includes(pass)) throw new CreatorError("Invalid motion reference frame", 400);
  const doc = await db.collection<MotionStudyDoc>("motion_studies").findOne({ _id: `${sid}:${studyId}`, session_id: sid });
  const file = doc?.files[index]?.[pass];
  if (!file) throw new CreatorError("Motion reference frame not found", 404);
  const stored = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!stored || stored.bytes.length !== file.bytes || bytesHash(stored.bytes) !== file.sha256) throw new CreatorError("Motion reference frame unavailable or corrupted", 503);
  return stored.bytes;
}
