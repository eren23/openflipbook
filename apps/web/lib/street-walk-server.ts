import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Db } from "mongodb";
import { getNode, type NodeRow } from "./db";
import { requireCreator, CreatorError } from "./creator";
import { isSafeId } from "./ids";
import { getStoredBytes, uploadJpeg, decodeDataUrl } from "./r2";
import { downloadDescentVideo, descentByteRange, validateDescentMp4 } from "./descent-video-store";
import { modalAuthHeaders, modalUrl } from "./modal";
import { worldReadHeaders } from "./world-read-response";

export const STREET_WALK_CEILING_USD = 0.40;
export const STREET_WALK_SECONDS = 5;
export const STREET_WALK_MODEL = "minimax/h3-max/image-to-video";
type Direction = "forward" | "left" | "right";
interface ImageReceipt { key: string; sha256: string; bytes: number; content_type: string; width: number; height: number }
interface VideoReceipt { key: string; sha256: string; bytes: number; content_type: "video/mp4"; model: string; duration_seconds: number }
export interface StreetStep {
  _id: string; id: string; request_id: string; request_ids: string[]; node_id: string; session_id: string;
  parent_id: string | null; direction: Direction; source: ImageReceipt; root_image_key: string;
  status: "submitting" | "storing" | "ready" | "submission_unknown" | "storage_failed";
  reservation: number; created_at: Date; provider_url?: string; provider_request_id?: string; video?: VideoReceipt;
  endpoint?: ImageReceipt & { kind: "browser-decoded-video-endpoint"; video_sha256: string; time_seconds: number; duration_seconds: number };
  error?: string;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const collection = (db: Db) => db.collection<StreetStep>("street_walk_steps");
const basePath = (nodeId: string, stepId: string) => `/api/nodes/${encodeURIComponent(nodeId)}/street-walk/${encodeURIComponent(stepId)}`;

export function parseStreetStep(value: unknown) {
  const b = value as Record<string, unknown> | null;
  if (!b || !isSafeId(b.request_id) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(b.request_id)
    || !["forward", "left", "right"].includes(String(b.direction))
    || !(b.parent_id === null || typeof b.parent_id === "string" && isSafeId(b.parent_id))) throw new CreatorError("Invalid street step", 400);
  return { request_id: b.request_id, direction: b.direction as Direction, parent_id: b.parent_id as string | null };
}

export async function streetWalkOwner(nodeId: string) {
  if (!isSafeId(nodeId)) throw new CreatorError("Invalid node", 400);
  const node = await getNode(nodeId);
  if (!node) throw new CreatorError("Street artwork not found", 404);
  const db = await requireCreator(node.session_id);
  if (node.scene_view?.level !== "street") throw new CreatorError("Start walking from street artwork", 409);
  return { node, db };
}

function wire(step: StreetStep) {
  return { id: step.id, request_id: step.request_id, request_ids: step.request_ids, parent_id: step.parent_id,
    direction: step.direction, status: step.status, reservation: step.reservation,
    source_sha256: step.source.sha256, created_at: step.created_at.toISOString(),
    video_url: step.video ? `${basePath(step.node_id, step.id)}/video` : null,
    video_sha256: step.video?.sha256 ?? null,
    end_frame_url: step.endpoint ? `${basePath(step.node_id, step.id)}/frame` : null,
    end_frame_sha256: step.endpoint?.sha256 ?? null, provider_request_id: step.provider_request_id ?? null, error: step.error ?? null };
}
export async function listStreetSteps(nodeId: string) {
  const { db } = await streetWalkOwner(nodeId);
  const steps = await collection(db).find({ node_id: nodeId }).sort({ created_at: 1 }).limit(100).toArray();
  return { segments: steps.map(wire), quote_ceiling_usd: STREET_WALK_CEILING_USD, duration_seconds: STREET_WALK_SECONDS };
}

async function readImage(key: string): Promise<{ receipt: ImageReceipt; data_url: string }> {
  const stored = await getStoredBytes(key, AbortSignal.timeout(30_000));
  if (!stored || !["image/png", "image/jpeg", "image/webp"].includes(stored.contentType) || stored.bytes.length > 12 * 1024 * 1024) throw new CreatorError("Saved street image unavailable", 503);
  const image = sharp(stored.bytes, { limitInputPixels: 16_777_216, failOn: "warning" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new CreatorError("Invalid street image", 422);
  await image.stats();
  return { receipt: { key, sha256: hash(stored.bytes), bytes: stored.bytes.length, content_type: stored.contentType, width: metadata.width, height: metadata.height }, data_url: `data:${stored.contentType};base64,${stored.bytes.toString("base64")}` };
}

async function findStep(db: Db, node: NodeRow, id: string) {
  if (!isSafeId(id)) throw new CreatorError("Invalid street step", 400);
  const step = await collection(db).findOne({ id, node_id: node.id, session_id: node.session_id });
  if (!step) throw new CreatorError("Street step not found", 404);
  return step;
}

async function finishStreetStorage(db: Db, step: StreetStep) {
  try {
    if (!step.provider_url) throw new Error("Missing paid result");
    const bytes = await downloadDescentVideo(step.provider_url);
    const sha256 = hash(bytes);
    const video: VideoReceipt = { key: `${step.session_id}/street-walk/${step.id}/${sha256}.mp4`, sha256, bytes: bytes.length, content_type: "video/mp4", model: STREET_WALK_MODEL, duration_seconds: STREET_WALK_SECONDS };
    await uploadJpeg(video.key, bytes, video.content_type, AbortSignal.timeout(90_000));
    const saved = await collection(db).updateOne({ _id: step._id, status: "storing" }, { $set: { status: "ready", video }, $unset: { error: "" } });
    if (saved.matchedCount !== 1) throw new Error("Street storage claim changed");
    step.status = "ready"; step.video = video; delete step.error;
  } catch {
    step.status = "storage_failed";
    step.error = "The generated step could not be stored. Retry saving this step without another generation charge.";
    await collection(db).updateOne({ _id: step._id, status: "storing" }, { $set: { status: step.status, error: step.error } });
  }
}

async function receiveStreetResult(db: Db, step: StreetStep, response: Response) {
  const result = await response.json() as { video_url?: string; model?: string; content_type?: string; duration_seconds?: number; provider_request_id?: string };
  if (isSafeId(result.provider_request_id)) {
    step.provider_request_id = result.provider_request_id;
    await collection(db).updateOne({_id:step._id},{$set:{provider_request_id:result.provider_request_id}});
  }
  if (!response.ok || !result.video_url || result.model !== STREET_WALK_MODEL || result.content_type !== "video/mp4" || result.duration_seconds !== STREET_WALK_SECONDS) throw new CreatorError("Street provider outcome could not be verified. This step will not be automatically submitted again.",502);
  step.status = "storing"; step.provider_url = result.video_url;
  await collection(db).updateOne({_id:step._id},{$set:{status:"storing",provider_url:result.video_url}});
  await finishStreetStorage(db,step);
}

/** The unique source/direction edge is inserted before a paid submission.
 * A lost response, another tab, or another UUID reuses this edge forever. */
export async function createStreetStep(nodeId: string, value: unknown) {
  const input = parseStreetStep(value);
  const { db, node } = await streetWalkOwner(nodeId);
  const edgeId = `${nodeId}:${input.parent_id ?? "root"}:${input.direction}`;
  // A request UUID, including every reused-edge alias, has exactly one body.
  const requests = db.collection<{_id: string; edge_id: string}>("street_walk_requests");
  const bindingId = `${nodeId}:${input.request_id}`;
  try { await requests.insertOne({ _id: bindingId, edge_id: edgeId }); }
  catch (error) {
    if ((error as {code?:number}).code !== 11000) throw error;
    if ((await requests.findOne({_id:bindingId}))?.edge_id !== edgeId) throw new CreatorError("Street request already belongs to a different direction or source",409);
  }
  const previous = await collection(db).findOne({ _id: edgeId });
  const reuse = async (step: StreetStep) => {
    if (step.session_id !== node.session_id || step.root_image_key !== node.image_key) throw new CreatorError("Street source changed", 409);
    await collection(db).updateOne({ _id: edgeId }, { $addToSet: { request_ids: input.request_id } });
    if (step.status === "storage_failed" && step.provider_url) {
      const claim = await collection(db).updateOne({ _id: edgeId, status: "storage_failed" }, { $set: { status: "storing" } });
      if (claim.matchedCount === 1) { step.status = "storing"; await finishStreetStorage(db,step); }
    }
    if (step.status === "submission_unknown" && step.provider_request_id && process.env.MODAL_API_URL) {
      const claim = await collection(db).updateOne({_id:edgeId,status:"submission_unknown"},{$set:{status:"submitting"}});
      if (claim.matchedCount === 1) {
        step.status = "submitting";
        try {
          const response = await fetch(modalUrl(process.env.MODAL_API_URL,"/street-walk/recover"),{method:"POST",headers:{"Content-Type":"application/json",...modalAuthHeaders()},body:JSON.stringify({provider_request_id:step.provider_request_id}),signal:AbortSignal.timeout(300_000)});
          await receiveStreetResult(db,step,response);
        } catch {
          step.status = "submission_unknown"; step.error = "The saved provider request is not ready. Check or recover this same step without a new generation charge.";
          await collection(db).updateOne({_id:edgeId},{$set:{status:step.status,error:step.error}});
        }
      }
    }
    return { segment: wire({ ...step, request_ids: [...new Set([...step.request_ids, input.request_id])] }) };
  };
  if (previous) return reuse(previous);
  const backend = process.env.MODAL_API_URL;
  if (!backend) throw new CreatorError("Street generation unavailable", 503);
  let key = node.image_key;
  let parent: StreetStep | null = null;
  if (input.parent_id) {
    parent = await findStep(db, node, input.parent_id);
    if (parent.status !== "ready" || !parent.video || !parent.endpoint || parent.endpoint.video_sha256 !== parent.video.sha256 || parent.root_image_key !== node.image_key) throw new CreatorError("Finish and save the previous street step first", 409);
    key = parent.endpoint.key;
  }
  const source = await readImage(key);
  if (parent?.endpoint && source.receipt.sha256 !== parent.endpoint.sha256) throw new CreatorError("Previous street endpoint changed", 409);
  const step: StreetStep = { _id: edgeId, id: input.request_id, request_id: input.request_id, request_ids: [input.request_id],
    node_id: nodeId, session_id: node.session_id, parent_id: input.parent_id, direction: input.direction,
    root_image_key: node.image_key, source: source.receipt, status: "submitting", reservation: STREET_WALK_CEILING_USD, created_at: new Date() };
  try { await collection(db).insertOne(step); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const winner = await collection(db).findOne({ _id: edgeId });
    if (!winner) throw new CreatorError("Street step unavailable", 503);
    return reuse(winner);
  }
  try {
    // This request continues independently of a browser disconnect; its
    // write-once edge fences retries even when the provider outcome is unknown.
    const response = await fetch(modalUrl(backend, "/animate"), { method: "POST", headers: { "Content-Type": "application/json", ...modalAuthHeaders() },
      body: JSON.stringify({ image_data_url: source.data_url, prompt: node.page_title ?? "Fantasy street", duration: STREET_WALK_SECONDS,
        video_tier: "balanced", session_id: node.session_id, street_walk: { direction: input.direction } }), signal: AbortSignal.timeout(300_000) });
    await receiveStreetResult(db,step,response);
  } catch {
    const status = step.status === "storing" ? "storage_failed" : "submission_unknown";
    const message = status === "storage_failed" ? "The generated step could not be stored. It will not be charged again automatically." : "The provider outcome is unknown. This step will not be charged again automatically.";
    await collection(db).updateOne({ _id: edgeId }, { $set: { status, error: message } });
    step.status = status; step.error = message;
  }
  return { segment: wire(step) };
}

export function endpointInput(value: unknown, videoSha: string) {
  const b = value as Record<string, unknown> | null;
  if (!b || b.video_sha256 !== videoSha || typeof b.image_data_url !== "string" || b.image_data_url.length > 16 * 1024 * 1024
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(b.image_data_url)
    || typeof b.time_seconds !== "number" || typeof b.duration_seconds !== "number"
    || !Number.isFinite(b.time_seconds) || !Number.isFinite(b.duration_seconds)
    || b.duration_seconds < 4.8 || b.duration_seconds > 5.6 || b.time_seconds < b.duration_seconds - 0.25 || b.time_seconds > b.duration_seconds) throw new CreatorError("Save the decoded ending frame of this street video", 400);
  return { image_data_url: b.image_data_url, time_seconds: b.time_seconds, duration_seconds: b.duration_seconds };
}
export async function saveStreetEndpoint(nodeId: string, stepId: string, value: unknown) {
  const { db, node } = await streetWalkOwner(nodeId);
  const step = await findStep(db, node, stepId);
  if (step.status !== "ready" || !step.video) throw new CreatorError("Street video is not ready", 409);
  const input = endpointInput(value, step.video.sha256);
  if (step.endpoint) return { end_frame_url: `${basePath(nodeId, stepId)}/frame`, sha256: step.endpoint.sha256 };
  const { bytes } = decodeDataUrl(input.image_data_url);
  const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" });
  const metadata = await image.metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256 || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) throw new CreatorError("Invalid decoded street frame", 400);
  await image.stats();
  const sha256 = hash(bytes), key = `${node.session_id}/street-walk/${stepId}/${sha256}.png`;
  await uploadJpeg(key, bytes, "image/png", AbortSignal.timeout(30_000));
  const endpoint: StreetStep["endpoint"] = { key, sha256, bytes: bytes.length, content_type: "image/png", width: metadata.width, height: metadata.height,
    kind: "browser-decoded-video-endpoint", video_sha256: step.video.sha256, time_seconds: input.time_seconds, duration_seconds: input.duration_seconds };
  await collection(db).updateOne({ _id: step._id, endpoint: { $exists: false }, "video.sha256": step.video.sha256 }, { $set: { endpoint } });
  const saved = await findStep(db, node, stepId);
  if (!saved.endpoint) throw new CreatorError("Ending frame was not saved", 503);
  return { end_frame_url: `${basePath(nodeId, stepId)}/frame`, sha256: saved.endpoint.sha256 };
}

export async function streetMedia(nodeId: string, stepId: string, kind: "video" | "frame", req: Request) {
  const { db, node } = await streetWalkOwner(nodeId);
  const step = await findStep(db, node, stepId);
  const receipt = kind === "video" ? step.video : step.endpoint;
  if (!receipt) throw new CreatorError("Street media not found", 404);
  const stored = await getStoredBytes(receipt.key, AbortSignal.timeout(30_000));
  if (!stored || stored.contentType !== receipt.content_type || stored.bytes.length !== receipt.bytes || hash(stored.bytes) !== receipt.sha256) throw new CreatorError("Street media failed byte verification", 422);
  const headers: Record<string,string> = { ...worldReadHeaders, "Content-Type": receipt.content_type, "X-Content-Type-Options": "nosniff", ETag: `"${receipt.sha256}"` };
  let body = stored.bytes, status = 200;
  if (kind === "video") {
    validateDescentMp4(body);
    headers["Accept-Ranges"] = "bytes";
    let range;
    try { range = descentByteRange(req.headers.has("if-range") ? null : req.headers.get("range"), body.length); }
    catch { return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${body.length}`}}); }
    if (range) { headers["Content-Range"] = `bytes ${range.start}-${range.end}/${body.length}`; body = body.subarray(range.start,range.end+1); status = 206; }
  }
  headers["Content-Length"] = String(body.length);
  return new Response(new Uint8Array(body), { status, headers });
}
