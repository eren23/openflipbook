import type { Document } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { archiveHash, archiveList, archiveObject, invalidArchive, type WorldArchive } from "./world-import-archive";
import { isSafeId } from "./ids";
import { VIEW_PASSES, type ViewSource } from "./place-view";
import { viewHash, type PlaceViewDoc } from "./place-view-store";
import { parseCaptureMetadata, wirePlaceView } from "./place-view-server";
import { reportedPreflight } from "./motion-study-server";
import { prepareCameraMotion, H3_CAMERA_ADAPTER_V1 } from "./camera-motion";
import { measureMotionLandmarks } from "./camera-motion-reference";
import { illustrationDependency } from "./illustration-input";
import { motionComparisonPlan, parseMotionReview, evaluateMotionReview } from "./motion-comparison";
import { inspectMotionArchiveVideos } from "./motion-video";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionFile, MotionReviewDoc } from "./motion-job";
import type { WorldImportPlan } from "./world-import-plan";

const id = (v: unknown): string => isSafeId(v) ? v : invalidArchive("Invalid motion archive identity");
const text = (v: unknown, cap: number): string => typeof v === "string" && v.length <= cap ? v : invalidArchive("Invalid motion archive text");
const hash = (v: unknown): string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalidArchive("Invalid motion archive hash");
const date = (v: unknown) => { const d = new Date(text(v, 40)); if (!Number.isFinite(d.getTime())) invalidArchive("Invalid motion archive date"); return d; };
const same = (a: unknown, b: unknown, message: string) => { if (!isDeepStrictEqual(a, b)) invalidArchive(message); };

// Imported metadata is a claim, not trusted calibration evidence. Rebuild the
// camera preparation and mask measurements, verify media locally, and never
// restore jobs, provider leases, budgets or generation consent.
export async function importWorldMotion(archive: WorldArchive, sid: string, records: Record<string, Document[]>, uploads: WorldImportPlan["uploads"]) {
  if (archive.manifest.version === 1 && !archive.files.has("motion.json")) return;
  const content = archiveObject(archive.json("motion.json"));
  if (content.version !== 1) invalidArchive("Unsupported motion archive version");
  const sourceSid = id(archive.manifest.session_id), files = new Map<string, { file: string; bytes: number; sha256: string }>();
  for (const raw of archiveList(content.files, 15000).map(archiveObject)) {
    const key = text(raw.key, 2000), file = text(raw.file, 500), data = archive.files.get(file);
    if (files.has(key) || !data || raw.bytes !== data.length || hash(raw.sha256) !== archiveHash(data)) invalidArchive("Missing, duplicate or corrupted motion file");
    files.set(key, { file, bytes: data!.length, sha256: String(raw.sha256) });
  }
  const used = new Set<string>();
  function stored(raw: unknown) {
    const f = archiveObject(raw), key = text(f.key, 2000), entry = files.get(key);
    if (!entry || entry.bytes !== f.bytes || entry.sha256 !== f.sha256) return invalidArchive("Motion file binding differs from its bundled bytes");
    used.add(key);
    return { bytes: archive.files.get(entry.file)!, descriptor: { key: `${sid}/restored/${entry.sha256}`, sha256: entry.sha256, bytes: entry.bytes } };
  }
  function upload(bytes: Buffer, descriptor: MotionFile, contentType: string) {
    const prior = uploads.find(u => u.key === descriptor.key);
    if (prior) { if (!prior.bytes.equals(bytes) || prior.contentType !== contentType) invalidArchive("Conflicting restored motion asset"); }
    else uploads.push({ key: descriptor.key, bytes, contentType });
  }
  async function image(raw: unknown, view: PlaceViewDoc, formats: string[]) {
    const result = stored(raw), decoder = sharp(result.bytes, { limitInputPixels: 1024 * 1024, failOn: "warning" }), info = await decoder.metadata();
    if (!formats.includes(info.format ?? "") || info.width !== view.width || info.height !== view.height || (info.pages ?? 1) !== 1 || info.orientation && info.orientation !== 1)
      return invalidArchive("Motion image encoding or camera dimensions differ");
    await decoder.stats(); upload(result.bytes, result.descriptor, `image/${info.format}`); return result;
  }
  const studyHashes = new Map<string, string>(), studies = new Map<string, MotionStudyDoc>(), perView = new Map<string, number>();
  for (const raw of archiveList(content.studies).map(archiveObject)) {
    const studyId = id(raw.id), viewId = id(raw.view_id), view = records.place_views?.find(v => v.id === viewId) as PlaceViewDoc | undefined;
    if (!view || studies.has(studyId) || raw._id !== `${sourceSid}:${studyId}` || raw.session_id !== sourceSid) invalidArchive("Missing camera or duplicate motion study");
    perView.set(viewId, (perView.get(viewId) ?? 0) + 1); if (perView.get(viewId)! > 20) invalidArchive("Too many motion studies for one camera");
    const source = archiveObject(raw.source), sourceImage = archiveObject(source.image), assetId = sourceImage.asset_id === null ? null : id(sourceImage.asset_id);
    const illustration = assetId ? records.illustration_assets?.find(a => a.id === assetId) : null;
    if (assetId && (!illustration || illustration.edit_input || !isDeepStrictEqual(illustration.view_dependency, illustrationDependency(view!)))) invalidArchive("Motion source illustration does not match its saved camera");
    const expectedImage = illustration ?? view!.files.render;
    if (sourceImage.sha256 !== expectedImage.sha256 || sourceImage.bytes !== expectedImage.bytes) invalidArchive("Motion source pixels differ from the saved camera artwork");
    const sourceView = wirePlaceView(view!, false);
    delete sourceView.accepted_illustration_id;
    if (assetId) sourceView.accepted_illustration_id = assetId;
    same(source.view, sourceView, "Motion source camera changed");
    const definitions: ViewSource[] = view!.sources.map(s => {
      const scene = records.place_scene_versions?.find(v => v.place_id === s.place_id && v.revision === s.revision && v.id === s.scene_id);
      if (!scene) return invalidArchive("Motion source geometry is missing");
      return { scene_id: s.scene_id, place_id: s.place_id, revision: s.revision, x: s.x, z: s.z, definition: scene.definition };
    });
    same(source.definitions, definitions, "Motion source geometry differs from saved revisions");
    const capture = parseCaptureMetadata({ ...view, sources: definitions, passes: { render: "", depth: "", normals: "", objects: "" } });
    // Archives made before the v2 adapter rebuild with v1 and must match it exactly.
    const preparation = prepareCameraMotion(capture, (raw.preparation as { adapter?: unknown } | null)?.adapter === H3_CAMERA_ADAPTER_V1 ? H3_CAMERA_ADAPTER_V1 : undefined);
    same(raw.preparation, preparation, "Motion adapter or camera preparation differs");
    const fingerprint = { view_id: viewId, view_input_sha256: view!.request_sha256,
      image: { kind: assetId ? "accepted_illustration" : "render", asset_id: assetId, sha256: sourceImage.sha256, width: view!.width, height: view!.height },
      registration: "saved_camera_dependency_not_visual_attestation", sources: view!.sources, assets: view!.assets };
    if (raw.preparation_sha256 !== viewHash({ motion: preparation, source: fingerprint })) invalidArchive("Motion preparation fingerprint differs");
    if (raw.status !== "reference_only" || raw.provenance !== "client_rendered_saved_geometry" || raw.preflight !== "not_server_attested") invalidArchive("Unsupported motion provenance");
    const sourceFile = await image(sourceImage, view!, ["png", "jpeg"]), frames: MotionStudyDoc["frames"] = [], frameFiles: MotionStudyDoc["files"] = [];
    const inputFrames = archiveList(raw.frames, 64).map(archiveObject), inputFiles = archiveList(raw.files, 64).map(archiveObject);
    if (inputFrames.length !== preparation.reference_cameras.length || inputFiles.length !== inputFrames.length) invalidArchive("Motion reference samples are incomplete");
    let total = sourceFile.bytes.length;
    for (const [i, expected] of preparation.reference_cameras.entries()) {
      const frame = inputFrames[i]!, camera = parseCaptureMetadata({ ...capture, path: undefined, camera: frame.camera }).camera;
      const close = (a: number[], b: number[]) => a.every((n, j) => Math.abs(n - b[j]!) <= 1e-10 * Math.max(1, Math.abs(n), Math.abs(b[j]!)));
      if (frame.time !== expected.time || frame.seconds !== expected.seconds || camera.near !== view!.camera.near || camera.far !== view!.camera.far
        || !close(camera.world_matrix, expected.world_matrix) || !isDeepStrictEqual(camera.projection_matrix, expected.projection_matrix)) invalidArchive("Motion sample camera or timing differs");
      const passes = {} as MotionStudyDoc["files"][number]; let measurements: MotionStudyDoc["frames"][number]["measurements"] | undefined;
      for (const pass of VIEW_PASSES) {
        const result = await image(inputFiles[i]![pass], view!, ["png"]); total += result.bytes.length;
        if (total > 48 * 1024 * 1024) invalidArchive("Motion study exceeds 48 MiB");
        passes[pass] = result.descriptor;
        if (pass === "objects") measurements = measureMotionLandmarks(await sharp(result.bytes).ensureAlpha().raw().toBuffer(), view!.width, view!.height, view!.objects);
      }
      same(frame.measurements, measurements, "Motion landmark measurements differ from the bundled masks");
      frames.push({ time: expected.time, seconds: expected.seconds, camera, measurements: measurements! }); frameFiles.push(passes);
    }
    const doc: MotionStudyDoc = { _id: `${sid}:${studyId}`, session_id: sid, id: studyId, view_id: viewId, label: text(raw.label, 120), created_at: date(raw.created_at).toISOString(),
      request_sha256: hash(raw.request_sha256), preparation_sha256: hash(raw.preparation_sha256), status: "reference_only", provenance: "client_rendered_saved_geometry", preflight: "not_server_attested",
      client_preflight: reportedPreflight(raw.client_preflight), preparation, frames, files: frameFiles,
      source: { view: sourceView, definitions, image: { ...sourceFile.descriptor, asset_id: assetId } },
      restored_from: { session_id: sourceSid, study_id: studyId, study_sha256: viewHash(raw), archive_sha256: archive.sha256, provenance: "user_supplied_archive" } };
    studyHashes.set(studyId, viewHash(raw)); studies.set(studyId, doc);
  }
  const assets = new Map<string, MotionAssetDoc>();
  const assetRows = archiveList(content.assets).map(archiveObject), reviewRows = archiveList(content.reviews).map(archiveObject);
  for (const [rows, key, cap] of [[assetRows, "study_id", 20], [reviewRows, "asset_id", 20]] as const) {
    const counts = new Map<string, number>();
    for (const row of rows) { const group = id(row[key]), count = (counts.get(group) ?? 0) + 1; counts.set(group, count); if (count > cap) invalidArchive("Motion archive exceeds the saved library limit"); }
  }
  for (const raw of assetRows) {
    const assetId = id(raw.id), studyId = id(raw.study_id), study = studies.get(studyId);
    if (!study || assets.has(assetId) || raw._id !== `${sourceSid}:${assetId}` || raw.session_id !== sourceSid || raw.study_sha256 !== studyHashes.get(studyId)
      || raw.preparation_sha256 !== study.preparation_sha256 || raw.model !== study.preparation.model || raw.adapter !== study.preparation.adapter) invalidArchive("Motion clip source binding differs");
    same(raw.parameters, study!.preparation.parameters, "Motion clip parameters differ from the saved path");
    const comparison = raw.comparison == null ? undefined : archiveObject(raw.comparison);
    const plan = motionComparisonPlan(study!);
    if (comparison) { same(comparison.plan, plan, "Motion comparison differs from reference masks"); if (comparison.sha256 !== viewHash(plan)) invalidArchive("Motion comparison hash differs"); }
    const original = stored(raw.original), silent = stored(raw.silent), media = await inspectMotionArchiveVideos(original.bytes, silent.bytes);
    same(raw.media, media, "Motion video metadata differs from bundled bytes");
    upload(original.bytes, original.descriptor, "video/mp4"); upload(silent.bytes, silent.descriptor, "video/mp4");
    const doc: MotionAssetDoc = { _id: `${sid}:${assetId}`, session_id: sid, id: assetId, study_id: studyId, study_sha256: viewHash(study),
      preparation_sha256: study!.preparation_sha256, model: study!.preparation.model, adapter: study!.preparation.adapter, parameters: study!.preparation.parameters,
      request_id: text(raw.request_id, 500), expanded_prompt: raw.expanded_prompt == null ? null : text(raw.expanded_prompt, 20000), created_at: date(raw.created_at),
      original: original.descriptor, silent: silent.descriptor, media, ...(comparison ? { comparison: { plan, sha256: viewHash(plan) } } : {}),
      restored_from: { session_id: sourceSid, asset_id: assetId, study_sha256: studyHashes.get(studyId)!, archive_sha256: archive.sha256, provenance: "user_supplied_archive" } };
    assets.set(assetId, doc);
  }
  const reviews = new Map<string, MotionReviewDoc>();
  for (const raw of reviewRows) {
    const reviewId = id(raw.id), asset = assets.get(id(raw.asset_id));
    if (!asset?.comparison || reviews.has(reviewId) || raw._id !== `${sourceSid}:${reviewId}` || raw.session_id !== sourceSid || raw.study_id !== asset.study_id
      || raw.video_sha256 !== asset.silent.sha256 || raw.comparison_sha256 !== asset.comparison.sha256) invalidArchive("Motion review binding differs");
    const review = parseMotionReview(raw.review, asset!.comparison!.plan), outcome = evaluateMotionReview(asset!.comparison!.plan, review, asset!.media);
    same(raw.outcome, outcome, "Motion review outcome differs from its measurements");
    reviews.set(reviewId, { _id: `${sid}:${reviewId}`, session_id: sid, id: reviewId, study_id: asset!.study_id, asset_id: asset!.id, request_sha256: hash(raw.request_sha256),
      comparison_sha256: asset!.comparison!.sha256, video_sha256: asset!.silent.sha256, review, outcome, created_at: date(raw.created_at) });
  }
  const selections = new Map<string, Document>();
  for (const raw of archiveList(content.selections).map(archiveObject)) {
    const asset = assets.get(id(raw.asset_id));
    if (!asset || selections.has(asset.study_id) || raw._id !== `${sourceSid}:${asset.study_id}`) invalidArchive("Selected motion clip is missing or duplicated");
    const review = raw.review_id == null ? undefined : reviews.get(id(raw.review_id));
    if ((raw.review_id != null || asset!.comparison) && (!review || review.asset_id !== asset!.id || review.outcome.status !== "pass")) invalidArchive("Selected motion review is missing or not passing");
    selections.set(asset!.study_id, { _id: `${sid}:${asset!.study_id}`, asset_id: asset!.id, ...(review ? { review_id: review.id } : {}) });
  }
  if (used.size !== files.size) invalidArchive("Archive contains unbound motion files");
  records.motion_studies = [...studies.values()]; records.motion_assets = [...assets.values()]; records.motion_reviews = [...reviews.values()]; records.motion_selections = [...selections.values()];
}
