import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { withDbTransaction } from "./db";
import { CreatorError } from "./creator-error";
import { uploadJpeg } from "./r2";
import { meshDownloadUrl } from "./mesh-asset";
import { download, verified } from "./motion-execution";
import { silentMotionVideo } from "./motion-video";
import { isSafeId } from "./ids";
import { imageLedBytesHash, imageLedHash, IMAGE_LED_IMAGE_LIMIT, fenceImageLedSource } from "./image-led-walk-source";
import { imageLedBackend, ImageLedBackendError, imageLedCapabilities, imageLedInputs, imageLedSeed, type ImageLedStepDoc } from "./image-led-walk-server";
import type { ImageLedCopyFirstProvenance, ImageLedImage, ImageLedWalkDoc } from "./image-led-walk";
import { copyFirstDepth, copyFirstWarp, type CopyFirstParameters } from "./image-led-copy-first";
import { prepareImageLedPlayback } from "./image-led-walk-playback";
const slot = (job: ImageLedStepDoc) => `${job.kind === "still" ? "frames" : "legs"}.${job.index}`;
const due = () => ({ $or: [{ next_check: { $exists: false } }, { next_check: { $lte: new Date() } }] });
function clearOwnSlot(walk: ImageLedWalkDoc, job: ImageLedStepDoc): ImageLedWalkDoc {
  const key = job.kind === "still" ? "frames" : "legs", rows = [...walk[key]], current = rows[job.index];
  if (!current || current.job_id !== job.id) throw new CreatorError("Saved step binding changed", 409);
  const { job_id: _job, error: _error, ...rest } = current; rows[job.index] = { ...rest, status: "empty" };
  return { ...walk, [key]: rows } as ImageLedWalkDoc;
}
async function update(db: Db, job: ImageLedStepDoc, values: Record<string, unknown>, frameValues?: Record<string, unknown>) {
  await withDbTransaction(async (tx, session) => {
    const options = { session }, guard = { _id: job._id, status: { $nin: ["ready", "failed"] as const }, ...(job.work_token ? { work_token: job.work_token } : {}) };
    if (!(await tx.collection<ImageLedStepDoc>("image_led_walk_steps").updateOne(guard, { $set: { ...values, updated_at: new Date() } }, options)).matchedCount) return;
    const value = frameValues ?? { status: values.status, ...(values.error ? { error: values.error } : {}) }, updates = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [`${slot(job)}.${k}`, v]));
    await tx.collection<ImageLedWalkDoc>("image_led_walks").updateOne({ _id: `${job.session_id}:${job.walk_id}`, [`${slot(job)}.job_id`]: job.id }, { $set: { ...updates, updated_at: new Date(), ...(values.status === "ready" || values.status === "failed" || values.status === "submission_unknown" || values.status === "storage_failed" ? { status: "needs_review" } : {}) }, $inc: { revision: 1 } }, options);
  });
}
async function rejectScheduled(db: Db, job: ImageLedStepDoc) {
  await withDbTransaction(async (tx, session) => {
    const options = { session }, jobs = tx.collection<ImageLedStepDoc>("image_led_walk_steps"), current = await jobs.findOne({ _id: job._id, status: "scheduled" }, options); if (!current) return;
    if (!current.reservation_released) for (const id of current.ledger_ids) await tx.collection<{ _id: string }>("spend_ledger").updateOne({ _id: id }, { $inc: { total: -current.quote.reservation } }, options);
    await jobs.updateOne({ _id: job._id, status: "scheduled" }, { $set: { status: "failed", reservation_released: true, error: "Source or review changed before submission; reservation released." } }, options);
    await tx.collection<ImageLedWalkDoc>("image_led_walks").updateOne({ _id: `${job.session_id}:${job.walk_id}`, [`${slot(job)}.job_id`]: job.id }, { $set: { [`${slot(job)}.status`]: "failed", [`${slot(job)}.error`]: "Source changed before submission; nothing was generated.", status: "needs_review" }, $inc: { revision: 1 } }, options);
  });
}
async function submit(db: Db, job: ImageLedStepDoc) {
  const jobs = db.collection<ImageLedStepDoc>("image_led_walk_steps"); let walk: ImageLedWalkDoc, inputs: Awaited<ReturnType<typeof imageLedInputs>>;
  try {
    const current = await db.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: `${job.session_id}:${job.walk_id}`, session_id: job.session_id }); if (!current) throw new CreatorError("Owned route missing", 409); walk = current;
    const cap = await imageLedCapabilities(db, job.quote.copy_first ? "copy_first" : job.kind); inputs = await imageLedInputs(db, clearOwnSlot(walk, job), job.kind, job.index, cap, job.quote.repair);
    if (inputs.sha256 !== job.input_sha256 || cap.model !== job.quote.model || imageLedHash(cap.parameters) !== imageLedHash(job.quote.parameters) || cap.reservation !== job.quote.reservation || imageLedHash(inputs.playback ?? null) !== imageLedHash(job.quote.playback ?? null)) throw new CreatorError("Quoted input or model changed before submission", 409);
  } catch (error) {
    if (error instanceof CreatorError && [400, 404, 409].includes(error.status)) {
      await rejectScheduled(db, job);
    } else await jobs.updateOne({ _id: job._id, status: "scheduled" }, { $set: { next_check: new Date(Date.now() + 30_000), error: "Source storage or compatible worker unavailable; nothing submitted." } });
    return;
  }
  let claimed: ImageLedStepDoc | null;
  try { claimed = await withDbTransaction(async (tx, session) => { const options = { session }, col = tx.collection<ImageLedStepDoc>("image_led_walk_steps"), current = await col.findOne({ _id: job._id, status: "scheduled" }, options); if (!current) return null;
    const latest = await tx.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: walk._id, revision: walk.revision }, options); if (!latest) return null;
    await fenceImageLedSource(tx, session, latest); if (latest.seed) await imageLedSeed(tx, latest.session_id, latest.seed, latest.source.image.sha256, session);
    const now = new Date(); if (!(await col.updateOne({ _id: job._id, status: "scheduled" }, { $set: { status: "submitting", submission_started_at: now, submission_deadline: new Date(now.getTime() + 130_000) } }, options)).matchedCount) return null;
    await tx.collection<ImageLedWalkDoc>("image_led_walks").updateOne({ _id: walk._id, revision: walk.revision }, { $set: { [`${slot(job)}.status`]: "submitting" }, $inc: { revision: 1 } }, options); return { ...current, status: "submitting" as const }; }); } catch (error) {
    if (error instanceof CreatorError && [400, 404, 409].includes(error.status)) await rejectScheduled(db, job);
    else await jobs.updateOne({ _id: job._id, status: "scheduled" }, { $set: { next_check: new Date(Date.now() + 30_000) } });
    return;
  }
  if (!claimed) return;
  // This durable claim is never reset. An interrupted POST cannot be re-sent.
  let acknowledgement: Record<string, unknown> = {};
  try {
    const result = await imageLedBackend(job.quote.copy_first ? "copy-first/generate" : job.kind === "still" ? "generate" : "video/generate", inputs.body);
    acknowledgement = result;
    if (!isSafeId(result.request_id) || result.model !== job.quote.model || result.profile !== "image-led-v1" || typeof result.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.input_sha256)) throw new Error("Submission receipt is invalid");
    await update(db, claimed, { status: "queued", provider_request_id: result.request_id, provider_input_sha256: result.input_sha256, next_check: new Date() });
  } catch (error) {
    const receipt = error instanceof ImageLedBackendError ? error.receipt : acknowledgement, detail = typeof receipt.detail === "object" && receipt.detail ? receipt.detail as Record<string, unknown> : receipt;
    const request = detail.provider_request_id ?? detail.request_id;
    await update(db, claimed, { status: "submission_unknown", ...(isSafeId(request) ? { provider_request_id: request } : {}), next_check: new Date(Date.now() + 5000), error: "Submission acknowledgement unavailable; this request will never be submitted again." });
  }
}
export async function downloadImageLedOutput(url: string) {
  const response = await fetch(meshDownloadUrl(url), { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000) }); if (!response.ok || !response.body || Number(response.headers.get("content-length")) > IMAGE_LED_IMAGE_LIMIT) throw new Error("Original image output unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > IMAGE_LED_IMAGE_LIMIT) { await reader.cancel(); throw new Error("Original image exceeds limit"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
/** The provider original is the depth map; the still is the approved prior warped by it, with no model pixel. */
async function copyFirstStill(db: Db, job: ImageLedStepDoc, depth: Buffer) {
  const copy = job.quote.copy_first!, params = job.quote.parameters as unknown as CopyFirstParameters;
  const walk = await db.collection<ImageLedWalkDoc>("image_led_walks").findOne({ _id: `${job.session_id}:${job.walk_id}` }), prior = walk?.frames[job.index - 1]?.raw;
  const priorBytes = prior?.sha256 === copy.prior_raw_sha256 ? await verified(prior) : null; if (!priorBytes) throw new CreatorError("The previous view changed or its original is missing", 409);
  const [p, d] = await Promise.all([sharp(priorBytes).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }), sharp(depth).extractChannel(0).raw().toBuffer({ resolveWithObject: true })]), { width: w, height: h } = p.info;
  if (p.info.channels !== 3 || d.info.channels !== 1 || d.info.width !== w || d.info.height !== h) throw new CreatorError("Depth map size differs from the previous view", 409);
  if (w * h > 4 * 1024 * 1024) throw new CreatorError("The previous view is too large to copy", 409);
  const out = copyFirstWarp(new Uint8Array(p.data), copyFirstDepth(new Uint8Array(d.data), params.offset), w, h, { tz: params.tz, yaw_degrees: copy.yaw_degrees, pitch_degrees: params.pitch_degrees, offset: params.offset, fov_degrees: params.fov_degrees });
  if (out.holes) throw new CreatorError(`Copy-first refused: ${out.holes} pixels are not covered by the previous view; quote a generated painting for this step`, 409);
  const bytes = await sharp(Buffer.from(out.rgb), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), sha256 = imageLedBytesHash(bytes), key = `${job.session_id}/image-led/${job.walk_id}/${job.id}/copy-${sha256}.png`;
  await uploadJpeg(key, bytes, "image/png", AbortSignal.timeout(60_000));
  const rawImage: ImageLedImage = { key, sha256, bytes: bytes.length, width: w, height: h, content_type: "image/png" };
  const copy_first: ImageLedCopyFirstProvenance = { ...copy, warp_version: params.warp_version, depth_request_id: job.provider_request_id!, depth_sha256: job.original!.sha256, tz: params.tz, pitch_degrees: params.pitch_degrees, offset: params.offset, fov_degrees: params.fov_degrees, bg_fill: true, uncovered_pixels: 0 };
  return { bytes, rawImage, copy_first };
}
async function store(db: Db, job: ImageLedStepDoc) {
  const result = job.provider_result!; let bytes = await verified(job.original);
  if (!bytes) {
    const media = job.kind === "still" ? result.image : result.video;
    if (!media || typeof media !== "object" || typeof (media as Record<string, unknown>).url !== "string") throw new Error("Original output receipt missing");
    bytes = job.kind === "still" ? await downloadImageLedOutput(String((media as Record<string, unknown>).url)) : await download(String((media as Record<string, unknown>).url));
    const sha256 = imageLedBytesHash(bytes), key = `${job.session_id}/image-led/${job.walk_id}/${job.id}/original-${sha256}.${job.kind === "still" ? "png" : "mp4"}`;
    await uploadJpeg(key, bytes, job.kind === "still" ? "image/png" : "video/mp4", AbortSignal.timeout(60_000));
    const original = { key, sha256, bytes: bytes.length, content_type: job.kind === "still" ? "image/png" as const : "video/mp4" as const };
    await db.collection<ImageLedStepDoc>("image_led_walk_steps").updateOne({ _id: job._id, ...(job.work_token ? { work_token: job.work_token } : {}) }, { $set: { original } }); job = { ...job, original };
  }
  if (job.kind === "still") {
    const raw = result.raw_image as Record<string, unknown> | undefined, metadata = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: "warning" }).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 || metadata.width > 4096 || metadata.height > 4096 || (metadata.orientation ?? 1) !== 1 || (metadata.pages ?? 1) !== 1) throw new CreatorError("Original draft format is invalid; downloaded bytes remain preserved", 409);
    let rawImage: ImageLedImage = { ...job.original!, width: metadata.width, height: metadata.height, content_type: "image/png" }, copy_first: ImageLedCopyFirstProvenance | undefined;
    // Readable originals are reviewable/exportable even when a provider byte
    // receipt or opacity check subsequently fails. They remain unapproved.
    if (!job.quote.copy_first) await db.collection<ImageLedWalkDoc>("image_led_walks").updateOne({ _id: `${job.session_id}:${job.walk_id}`, [`${slot(job)}.job_id`]: job.id }, { $set: { [`${slot(job)}.raw`]: rawImage }, $inc: { revision: 1 } });
    if (!raw || raw.valid !== true || raw.sha256 !== rawImage.sha256 || raw.bytes !== bytes.length || raw.width !== metadata.width || raw.height !== metadata.height) throw new CreatorError("Original draft byte receipt is invalid", 409);
    if (job.quote.copy_first) ({ bytes, rawImage, copy_first } = await copyFirstStill(db, job, bytes));
    else { const alpha = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); for (let i = 3; i < alpha.data.length; i += 4) if (alpha.data[i] !== 255) throw new CreatorError("Original draft is transparent", 409); }
    const playback = job.quote.playback ? await prepareImageLedPlayback(bytes, job.quote.playback) : await sharp(bytes).resize({ width: Math.min(688, metadata.width), withoutEnlargement: true }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer(), info = await sharp(playback).metadata(), sha256 = imageLedBytesHash(playback), key = `${job.session_id}/image-led/${job.walk_id}/${job.id}/playback-${sha256}.jpg`;
    await uploadJpeg(key, playback, "image/jpeg", AbortSignal.timeout(60_000));
    const image: ImageLedImage = { key, sha256, bytes: playback.length, width: info.width!, height: info.height!, content_type: "image/jpeg" };
    await update(db, job, { status: "ready", next_check: new Date(8640000000000000) }, { status: "ready", raw: rawImage, image, derivative: { kind: job.quote.playback ? "contain-jpeg-v1" : "uniform-scale-jpeg-v1", source_sha256: rawImage.sha256, crop: false, stretch: false, ...(job.quote.playback ? { canvas: job.quote.playback } : {}) }, copy_first });
  } else {
    const silent = await silentMotionVideo(bytes); if (Math.abs(silent.media.duration - Number(job.quote.parameters.duration)) > .6) throw new CreatorError("Clip duration differs from the quoted duration", 409);
    const key = `${job.session_id}/image-led/${job.walk_id}/${job.id}/playback-${silent.hashes.playback_sha256}.mp4`; await uploadJpeg(key, silent.bytes, "video/mp4", AbortSignal.timeout(60_000));
    await update(db, job, { status: "ready", next_check: new Date(8640000000000000) }, { status: "ready", original: job.original, video: { key, sha256: silent.hashes.playback_sha256, bytes: silent.bytes.length, content_type: "video/mp4" }, media: silent.media });
  }
}
/** One durable step per tick; only reads/storage have reclaimable leases. */
export async function processNextImageLedWalk(db: Db, videoEnabled = true): Promise<boolean> {
  const jobs = db.collection<ImageLedStepDoc>("image_led_walk_steps"), filter = { ...due(), ...(videoEnabled ? {} : { kind: "still" as const }) };
  const expired = await jobs.findOne({ status: "submitting", submission_deadline: { $lte: new Date() }, ...filter });
  if (expired) { await update(db, expired, { status: "submission_unknown", error: "Submission acknowledgement interrupted; no automatic retry." }); return true; }
  const scheduled = await jobs.findOne({ status: "scheduled", ...filter, ...(process.env.PATH_VIDEO_ENABLED === "1" && videoEnabled ? {} : { kind: "still" as const }) }, { sort: { created_at: 1, _id: 1 } }); if (scheduled) { await submit(db, scheduled); return true; }
  const candidate = await jobs.findOne({ status: { $in: ["queued", "running", "submission_unknown", "storage_failed"] }, provider_request_id: { $exists: true }, ...filter, $and: [{ $or: [{ work_until: { $exists: false } }, { work_until: { $lte: new Date() } }] }] }, { sort: { next_check: 1, created_at: 1 } }); if (!candidate) return false;
  const token = randomUUID(), leased = await jobs.findOneAndUpdate({ _id: candidate._id, status: candidate.status, $or: [{ work_until: { $exists: false } }, { work_until: { $lte: new Date() } }] }, { $set: { work_token: token, work_until: new Date(Date.now() + 300_000) } }, { returnDocument: "after" }); if (!leased) return true;
  try {
    if (!leased.provider_result) { const result = await imageLedBackend(`${leased.kind === "video" ? "video/" : ""}requests/${encodeURIComponent(leased.provider_request_id!)}${leased.kind === "still" ? `?model=${encodeURIComponent(leased.quote.model)}` : ""}`); if (result.request_id !== leased.provider_request_id || result.model !== leased.quote.model || result.profile !== "image-led-v1") throw new Error("Provider result binding changed");
      if (["queued", "running"].includes(String(result.status))) { await update(db, leased, { status: result.status, next_check: new Date(Date.now() + 5000) }); return true; }
      if (result.status === "failed") { await update(db, leased, { status: "failed", error: "Provider did not produce a usable result; no retry is authorized." }); return true; }
      if (result.status !== "ready") throw new Error("Unknown output status");
      await jobs.updateOne({ _id: leased._id, work_token: token }, { $set: { provider_result: result } }); leased.provider_result = result;
    }
    await store(db, leased);
  } catch (error) { await update(db, leased, { status: error instanceof CreatorError && error.status === 409 ? "failed" : leased.provider_result ? "storage_failed" : leased.status, next_check: new Date(Date.now() + 15_000), error: error instanceof CreatorError ? error.message : "Saved output retrieval unavailable; only this existing request can be recovered." }); }
  finally { await jobs.updateOne({ _id: leased._id, work_token: token }, { $unset: { work_token: "", work_until: "" } }); }
  return true;
}
