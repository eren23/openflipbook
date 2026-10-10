import { CreatorError, requireCreator } from "./creator";
import { getStoredBytes } from "./r2";
import { imageLedBytesHash, imageLedSourceContext } from "./image-led-walk-source";
import { readImageLedWalk } from "./image-led-walk-server";
import type { ImageLedFile } from "./image-led-walk";
import { motionPlaybackResponse } from "./motion-playback";
export async function readImageLedJson(req: Request): Promise<Record<string, unknown>> {
  if (!req.body || Number(req.headers.get("content-length")) > 32 * 1024) throw new CreatorError("Image-led request exceeds 32 KiB", 413);
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32 * 1024) { await reader.cancel(); throw new CreatorError("Image-led request exceeds 32 KiB", 413); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreatorError("Expected an image-led request object", 400);
  return value as Record<string, unknown>;
}
async function fileResponse(req: Request, file: ImageLedFile) {
  const max = file.content_type === "video/mp4" ? 150 * 1024 * 1024 : 12 * 1024 * 1024;
  if (file.bytes <= 0 || file.bytes > max) throw new CreatorError("Saved file exceeds its media limit", 503);
  const value = await getStoredBytes(file.key, AbortSignal.timeout(30_000));
  if (!value || value.bytes.length !== file.bytes || imageLedBytesHash(value.bytes) !== file.sha256) throw new CreatorError("Saved media bytes are unavailable or changed", 503);
  if (file.content_type === "video/mp4") return motionPlaybackResponse(req, value.bytes);
  return new Response(new Uint8Array(value.bytes), { headers: { "Content-Type": file.content_type, "Content-Length": String(file.bytes), "Cache-Control": "private, no-store", Vary: "Cookie", ETag: `"${file.sha256}"`, "X-Content-Type-Options": "nosniff" } });
}
export async function imageLedMedia(req: Request, sid: string, walkId: string, name: string) {
  const db = await requireCreator(sid), walk = await readImageLedWalk(db, sid, walkId); let file: ImageLedFile | undefined;
  if (name === "source") file = walk.source.image;
  else { const found = /^(landmark|frame|raw|video)-(0|[1-9]\d?)$/.exec(name); if (!found) throw new CreatorError("Saved media not found", 404); const index = Number(found[2]); file = found[1] === "landmark" ? walk.landmarks[index]?.image : found[1] === "frame" ? walk.frames[index]?.image : found[1] === "raw" ? walk.frames[index]?.raw : walk.legs[index]?.video; }
  if (!file) throw new CreatorError("Saved media not found", 404);
  return fileResponse(req, file);
}
export async function imageLedSourceMedia(req: Request, sid: string, nodeId: string) { const db = await requireCreator(sid); const context = await imageLedSourceContext(db, sid, nodeId); return fileResponse(req, context.source.image); }
