import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Document } from "mongodb";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";
import { archiveHash, archiveList, archiveObject, invalidArchive, type WorldArchive } from "./world-import-archive";
import { inspectArchivedPathVideo } from "./world-import-path-video";
import { inspectMotionArchiveVideos } from "./motion-video";
import { IMAGE_LED_MAP_FRAME, IMAGE_LED_WALK_PROFILE, type ImageLedFile, type ImageLedImage, type ImageLedWalkDoc } from "./image-led-walk";
import type { WorldImportPlan } from "./world-import-plan";
import { prepareImageLedPlayback, validateImageLedPlayback } from "./image-led-walk-playback";
import type { ImageLedPlayback } from "./image-led-walk";

export interface ImageLedWalkReceipt extends Omit<ImageLedWalkDoc, "_id" | "created_at" | "updated_at"> { created_at: string; updated_at: string }
export interface ImageLedWalkArchiveExport {
  receipts: ImageLedWalkReceipt[];
  files: (ImageLedFile & { file: string; data: Uint8Array })[];
}

/** Whitelist content; execution claims and provider requests live elsewhere. */
export function imageLedWalkReceipt(walk: ImageLedWalkDoc): ImageLedWalkReceipt {
  return {
    id: walk.id, session_id: walk.session_id, profile: walk.profile,
    created_at: new Date(walk.created_at).toISOString(), updated_at: new Date(walk.updated_at).toISOString(),
    request_sha256: walk.request_sha256, status: walk.status, source: structuredClone(walk.source),
    landmarks: structuredClone(walk.landmarks), route: structuredClone(walk.route), prompt: walk.prompt,
    ...(walk.seed ? { seed: structuredClone(walk.seed) } : {}), revision: walk.revision,
    frames: walk.frames.map(f => ({ index: f.index, status: f.image ? "ready" : "empty",
      ...(f.derivative ? { derivative: structuredClone(f.derivative) } : {}),
      ...(f.raw ? { raw: structuredClone(f.raw) } : {}), ...(f.image ? { image: structuredClone(f.image) } : {}), review: structuredClone(f.review) })),
    legs: walk.legs.map(l => ({ index: l.index, from: l.from, to: l.to, status: l.video ? "ready" : "empty",
      ...(l.original ? { original: structuredClone(l.original) } : {}), ...(l.video ? { video: structuredClone(l.video) } : {}),
      ...(l.media ? { media: structuredClone(l.media) } : {}), review: structuredClone(l.review) })),
    ...(walk.archive_provenance ? { archive_provenance: structuredClone(walk.archive_provenance) } : {}),
  };
}

export function inertImageLedWalkReceipt(receipt: ImageLedWalkReceipt, sid: string, nodeIds: Map<string, string>): ImageLedWalkDoc {
  const nodeId = nodeIds.get(receipt.source.node_id);
  if (!nodeId) throw new CreatorError("Image-led source page is missing; copy was not created", 409);
  return { ...structuredClone(receipt), _id: `${sid}:${receipt.id}`, session_id: sid, status: "archived",
    created_at: new Date(receipt.created_at), updated_at: new Date(receipt.updated_at), source: { ...structuredClone(receipt.source), node_id: nodeId },
    archive_provenance: { version: 1, source_session_id: receipt.session_id, source_id: receipt.id, original_status: receipt.status } };
}

export async function downloadImageLedWalkArchive(receipts: ImageLedWalkReceipt[],
  required: (key: string, label: string, expected: { bytes: number; sha256: string }) => Promise<{ bytes: Uint8Array }>): Promise<ImageLedWalkArchiveExport> {
  const files = new Map<string, ImageLedWalkArchiveExport["files"][number]>();
  async function include(file: ImageLedFile) {
    if (!file.key || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new CreatorError("Invalid image-led media receipt", 409);
    const previous = files.get(file.key);
    if (previous) {
      if (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes || previous.content_type !== file.content_type) throw new CreatorError("Conflicting image-led media receipt", 409);
      return;
    }
    const stored = await required(file.key, "image-led walk media", file);
    if (stored.bytes.length !== file.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new CreatorError("Image-led walk media is corrupted", 503);
    const extension = file.content_type === "video/mp4" ? "mp4" : file.content_type === "image/png" ? "png" : "jpg";
    files.set(file.key, { ...file, file: `image-led-walks/${files.size + 1}.${extension}`, data: stored.bytes });
  }
  for (const receipt of receipts) {
    await include(receipt.source.image);
    for (const landmark of receipt.landmarks) await include(landmark.image);
    if (receipt.seed) await include(receipt.seed.image);
    for (const frame of receipt.frames) { if (frame.raw) await include(frame.raw); if (frame.image) await include(frame.image); }
    for (const leg of receipt.legs) { if (leg.original) await include(leg.original); if (leg.video) await include(leg.video); }
  }
  return { receipts, files: [...files.values()] };
}

const id = (value: unknown): string => isSafeId(value) ? value : invalidArchive("Invalid image-led identity");
const text = (value: unknown, limit = 2000): string => typeof value === "string" && value.length <= limit ? value : invalidArchive("Invalid image-led text");
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalidArchive("Invalid image-led hash");
const number = (value: unknown, min: number, max: number): number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : invalidArchive("Invalid image-led number");
const integer = (value: unknown, min: number, max: number): number => Number.isSafeInteger(value) ? number(value, min, max) : invalidArchive("Invalid image-led integer");
const timestamp = (value: unknown) => { const date = new Date(text(value, 40)); return Number.isFinite(date.getTime()) ? date : invalidArchive("Invalid image-led timestamp"); };
function only(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some(key => !names.includes(key))) invalidArchive("Image-led receipt contains unsupported or execution state");
}
function review(raw: unknown, kind: "still" | "video", media?: ImageLedFile) {
  const value = archiveObject(raw);
  only(value, kind === "still" ? ["identity", "route", "spatial", "sha256", "reviewed_at", "notes"] : ["temporal", "sha256", "reviewed_at", "notes"]);
  const fields = kind === "still" ? ["identity", "route"] : ["temporal"];
  if (fields.some(field => !["pending", "approved", "rejected"].includes(String(value[field]))) || kind === "still" && value.spatial !== "unmeasured") invalidArchive("Invalid image-led review");
  if (fields.some(field => value[field] !== "pending")) {
    if (!media || hash(value.sha256) !== media.sha256) invalidArchive("Image-led review identifies different media");
    timestamp(value.reviewed_at);
  } else if (value.sha256 !== undefined && (!media || hash(value.sha256) !== media.sha256)) invalidArchive("Unbound image-led review");
  if (value.notes !== undefined) text(value.notes);
  return value;
}

/** Imports are immutable historical content. No image_led_walk_steps records are restored. */
export async function importWorldImageLedWalks(archive: WorldArchive, sid: string, records: Record<string, Document[]>, uploads: WorldImportPlan["uploads"], nodeIds: Map<string, string>) {
  if (!archive.files.has("image-led-walks.json")) { if (archive.manifest.version === 5) invalidArchive("Image-led archive metadata is missing"); return; }
  if (archive.manifest.version !== 5) invalidArchive("Image-led content requires archive version 5");
  const content = archiveObject(archive.json("image-led-walks.json"));
  only(content, ["version", "receipts", "files"]);
  if (content.version !== 1) invalidArchive("Unsupported image-led archive version");
  const sourceSid = id(archive.manifest.session_id), files = new Map<string, { bytes: Buffer; file: ImageLedFile }>(), used = new Set<string>();
  for (const raw of archiveList(content.files, 15000).map(archiveObject)) {
    only(raw, ["key", "sha256", "bytes", "content_type", "width", "height", "file"]);
    const key = text(raw.key), path = text(raw.file, 500), bytes = archive.files.get(path), sha256 = hash(raw.sha256);
    if (files.has(key) || !/^image-led-walks\/[0-9]+\.(png|jpg|mp4)$/.test(path) || !bytes || integer(raw.bytes, 1, 96 * 1024 * 1024) !== bytes.length || archiveHash(bytes) !== sha256
      || !["image/png", "image/jpeg", "video/mp4"].includes(String(raw.content_type))) invalidArchive("Missing or corrupted image-led media");
    files.set(key, { bytes: bytes!, file: { key: `${sid}/restored/${sha256}`, sha256, bytes: bytes!.length, content_type: raw.content_type as ImageLedFile["content_type"] } });
  }
  const verified = new Map<string, unknown>();
  async function stored(raw: unknown, image = false, silent = false) {
    const value = archiveObject(raw);
    only(value, image ? ["key", "sha256", "bytes", "content_type", "width", "height"] : ["key", "sha256", "bytes", "content_type"]);
    const found = files.get(text(value.key));
    if (!found || found.file.sha256 !== hash(value.sha256) || found.file.bytes !== value.bytes || found.file.content_type !== value.content_type) invalidArchive("Image-led file binding differs");
    used.add(String(value.key));
    const file = { ...found!.file };
    if (image) {
      if (file.content_type === "video/mp4" || file.bytes > 12 * 1024 * 1024) invalidArchive("Invalid image-led image type or size");
      const cacheKey = `${file.sha256}:image`;
      let info = verified.get(cacheKey) as { width?: number; height?: number } | undefined;
      if (!info) {
        const decoder = sharp(found!.bytes, { limitInputPixels: 16_777_216, failOn: "warning" }); info = await decoder.metadata();
        if ((info as { format?: string }).format !== file.content_type.slice(6) || !info.width || !info.height) invalidArchive("Invalid image-led image encoding");
        await decoder.stats(); verified.set(cacheKey, info);
      }
      if (integer(value.width, 16, 4096) !== info.width || integer(value.height, 16, 4096) !== info.height) invalidArchive("Image-led dimensions differ");
      Object.assign(file, { width: info.width, height: info.height });
    } else {
      if (file.content_type !== "video/mp4") invalidArchive("Invalid image-led video type");
      const cacheKey = `${file.sha256}:video:${silent}`;
      if (!verified.has(cacheKey)) verified.set(cacheKey, await inspectArchivedPathVideo(found!.bytes, silent));
    }
    const previous = uploads.find(item => item.key === file.key);
    if (previous && (!previous.bytes.equals(found!.bytes) || previous.contentType !== file.content_type)) invalidArchive("Conflicting image-led restored bytes");
    if (!previous) uploads.push({ key: file.key, bytes: found!.bytes, contentType: file.content_type });
    return file;
  }
  const seen = new Set<string>(), restored: Document[] = [];
  for (const raw of archiveList(content.receipts).map(archiveObject)) {
    only(raw, ["id", "session_id", "profile", "created_at", "updated_at", "request_sha256", "status", "source", "landmarks", "route", "prompt", "seed", "frames", "legs", "revision", "archive_provenance"]);
    const walkId = id(raw.id);
    if (seen.has(walkId) || raw.session_id !== sourceSid || raw.profile !== IMAGE_LED_WALK_PROFILE || !["draft", "active", "needs_review", "complete", "archived"].includes(String(raw.status))) invalidArchive("Invalid image-led walk identity");
    seen.add(walkId); hash(raw.request_sha256); text(raw.prompt, 4000); integer(raw.revision, 0, 1_000_000);
    const source = archiveObject(raw.source), route = archiveObject(raw.route);
    only(source, ["node_id", "image_key", "image", "map_frame", "source_projection", "binding_sha256"]);
    only(route, ["frame", "points", "map_sha256", "sha256"]);
    const nodeId = nodeIds.get(id(source.node_id)); if (!nodeId) invalidArchive("Image-led source page is missing");
    const sourceImage = await stored(source.image, true) as ImageLedImage;
    if (source.image_key !== archiveObject(source.image).key || hash(route.map_sha256) !== sourceImage.sha256 || source.source_projection !== "illustrated_oblique_or_unknown") invalidArchive("Image-led source binding differs");
    hash(source.binding_sha256); hash(route.sha256);
    const mapFrame = archiveObject(source.map_frame), bounds = archiveObject(mapFrame.bounds);
    only(mapFrame, ["bounds", "parent_id"]); only(bounds, ["x", "y", "w", "h"]);
    number(bounds.x, -1e8, 1e8); number(bounds.y, -1e8, 1e8); number(bounds.w, .000001, 1e8); number(bounds.h, .000001, 1e8); if (mapFrame.parent_id !== null) id(mapFrame.parent_id);
    const points = archiveList(route.points, 12).map(p => { const point = archiveObject(p); only(point, ["x", "y"]); return { x: number(point.x, 0, 1), y: number(point.y, 0, 1) }; });
    if (points.length < 2 || points.some((p, i) => i && p.x === points[i - 1]!.x && p.y === points[i - 1]!.y) || route.frame !== IMAGE_LED_MAP_FRAME) invalidArchive("Invalid image-led route");
    if (archiveHash(JSON.stringify({ frame: IMAGE_LED_MAP_FRAME, points, map_sha256: sourceImage.sha256 })) !== route.sha256) invalidArchive("Image-led route fingerprint differs");
    const landmarkIds = new Set<string>();
    const landmarks = [];
    for (const value of archiveList(raw.landmarks, 8).map(archiveObject)) {
      only(value, ["id", "entity_id", "label", "visual", "source_rectangle", "reference_kind", "image"]);
      const landmarkId = id(value.id); if (landmarkIds.has(landmarkId)) invalidArchive("Duplicate image-led landmark"); landmarkIds.add(landmarkId);
      if (value.entity_id !== null) id(value.entity_id); text(value.label, 160); text(value.visual, 2000);
      if (!["reviewed_source_crop", "identity_anchor", "appearance_bbox", "owner_reviewed_crop"].includes(String(value.reference_kind))) invalidArchive("Invalid image-led reference kind");
      const rect = archiveObject(value.source_rectangle); only(rect, ["left", "top", "width", "height"]);
      integer(rect.left, 0, sourceImage.width - 1); integer(rect.top, 0, sourceImage.height - 1); integer(rect.width, 1, sourceImage.width); integer(rect.height, 1, sourceImage.height);
      if (Number(rect.left) + Number(rect.width) > sourceImage.width || Number(rect.top) + Number(rect.height) > sourceImage.height) invalidArchive("Image-led crop is outside its source");
      landmarks.push({ ...value, image: await stored(value.image, true) });
    }
    const frames = [];
    for (const [index, value] of archiveList(raw.frames, 12).map(archiveObject).entries()) {
      only(value, ["index", "status", "raw", "image", "derivative", "review"]);
      if (value.index !== index || !["ready", "empty"].includes(String(value.status))) invalidArchive("Invalid image-led still inventory");
      const image = value.image ? await stored(value.image, true) : undefined, original = value.raw ? await stored(value.raw, true) : undefined;
      if ((value.status === "ready") !== Boolean(image) || image && !original) invalidArchive("Image-led still originals are missing");
      if (value.derivative) {
        const derivative = archiveObject(value.derivative); only(derivative, ["kind", "source_sha256", "crop", "stretch", "canvas"]);
        if (!image || !original || !["uniform-scale-jpeg-v1", "contain-jpeg-v1"].includes(String(derivative.kind)) || hash(derivative.source_sha256) !== original.sha256 || derivative.crop !== false || derivative.stretch !== false || image.content_type !== "image/jpeg") invalidArchive("Invalid image-led playback derivative");
        const a = image as ImageLedImage, b = original as ImageLedImage;
        if (derivative.kind === "contain-jpeg-v1") {
          let canvas: ImageLedPlayback;
          try { canvas = validateImageLedPlayback(archiveObject(derivative.canvas) as unknown as ImageLedPlayback); } catch { invalidArchive("Invalid image-led playback canvas"); }
          if (a.width !== canvas!.width || a.height !== canvas!.height) invalidArchive("Image-led playback canvas dimensions differ");
          const originalBytes = files.get(String(archiveObject(value.raw).key))!.bytes;
          if (archiveHash(await prepareImageLedPlayback(originalBytes, canvas!)) !== a.sha256) invalidArchive("Image-led playback pixels differ from declared whole-image padding");
        } else if (derivative.canvas !== undefined || a.width > b.width || a.height > b.height || Math.abs(a.height - b.height * a.width / b.width) > 1) invalidArchive("Image-led playback image is cropped or stretched");
      } else if (image && image.sha256 !== original!.sha256) invalidArchive("Image-led derivative declaration is missing");
      frames.push({ index, status: image ? "ready" : "empty", ...(image ? { image } : {}), ...(original ? { raw: original } : {}), ...(value.derivative ? { derivative: value.derivative } : {}), review: review(value.review, "still", image) });
    }
    const legs = [];
    for (const [index, value] of archiveList(raw.legs, 11).map(archiveObject).entries()) {
      only(value, ["index", "from", "to", "status", "original", "video", "media", "review"]);
      if (value.index !== index || value.from !== index || value.to !== index + 1 || !["ready", "empty"].includes(String(value.status))) invalidArchive("Invalid image-led leg inventory");
      const video = value.video ? await stored(value.video, false, true) : undefined, original = value.original ? await stored(value.original) : undefined;
      if ((value.status === "ready") !== Boolean(video) || Boolean(video) !== Boolean(original)) invalidArchive("Image-led video originals are missing");
      if (video) {
        const media = archiveObject(value.media); only(media, ["width", "height", "duration", "audio_streams", "source_audio_streams", "derivative"]);
        let actual;
        try {
          actual = await inspectMotionArchiveVideos(files.get(archiveObject(value.original).key as string)!.bytes, files.get(archiveObject(value.video).key as string)!.bytes);
        } catch { invalidArchive("Image-led video stream differs from its original"); }
        if (media.width !== actual!.width || media.height !== actual!.height || Math.abs(number(media.duration, 4.4, 5.6) - actual!.duration) > .1 || media.audio_streams !== 0 || media.derivative !== "silent_streamcopy_v1" || integer(media.source_audio_streams, 0, 100) !== actual!.source_audio_streams) invalidArchive("Image-led video inspection differs");
      } else if (value.media) invalidArchive("Image-led video metadata has no bytes");
      legs.push({ index, from: index, to: index + 1, status: video ? "ready" : "empty", ...(video ? { video, original, media: value.media } : {}), review: review(value.review, "video", video) });
    }
    if (frames.length !== points.length || legs.length !== points.length - 1) invalidArchive("Image-led checkpoint inventory differs");
    let seed;
    if (raw.seed) { const value = archiveObject(raw.seed); only(value, ["view_id", "asset_id", "sha256", "review_sha256", "image"]); id(value.view_id); id(value.asset_id); hash(value.review_sha256);
      const image = await stored(value.image, true); if (hash(value.sha256) !== image.sha256) invalidArchive("Image-led seed bytes differ"); seed = { ...value, image }; }
    restored.push({ _id: `${sid}:${walkId}`, id: walkId, session_id: sid, profile: IMAGE_LED_WALK_PROFILE,
      created_at: timestamp(raw.created_at), updated_at: timestamp(raw.updated_at), request_sha256: raw.request_sha256, status: "archived",
      source: { ...source, node_id: nodeId, image_key: sourceImage.key, image: sourceImage }, landmarks, route: { ...route, points }, prompt: raw.prompt,
      ...(seed ? { seed } : {}), frames, legs, revision: raw.revision,
      archive_provenance: { version: 1, source_session_id: sourceSid, source_id: walkId, original_status: raw.status } });
  }
  if ([...files.keys()].some(key => !used.has(key))) invalidArchive("Unreferenced image-led archive media");
  records.image_led_walks = restored;
}
