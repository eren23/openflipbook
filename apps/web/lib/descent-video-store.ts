import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";
import type { StoredDescentVideo } from "./descent-clip";
import { meshDownloadUrl } from "./mesh-asset";
import { uploadJpeg } from "./r2";

export const MAX_DESCENT_VIDEO_BYTES = 80 * 1024 * 1024;

export function descentProviderUrl(value: unknown): string {
  try { return meshDownloadUrl(value); }
  catch { throw new CreatorError("Unsupported descent video URL", 400); }
}

/** Validate a complete MP4 container without modifying its audio or video. */
export function validateDescentMp4(bytes: Buffer) {
  if (bytes.length < 32 || bytes.length > MAX_DESCENT_VIDEO_BYTES) throw new CreatorError("Invalid descent video size", 422);
  let offset = 0;
  const boxes = new Set<string>();
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new CreatorError("Incomplete descent video", 422);
    let size = bytes.readUInt32BE(offset);
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) throw new CreatorError("Incomplete descent video", 422);
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(MAX_DESCENT_VIDEO_BYTES)) throw new CreatorError("Invalid descent video size", 422);
      size = Number(extended);
      header = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (size < header || offset + size > bytes.length || (offset === 0 && (kind !== "ftyp" || size < 16))) throw new CreatorError("Expected a complete MP4 video", 422);
    boxes.add(kind);
    offset += size;
  }
  if (!boxes.has("moov") || !boxes.has("mdat")) throw new CreatorError("Expected a complete MP4 video", 422);
}

export async function downloadDescentVideo(url: string, send: typeof fetch = fetch): Promise<Buffer> {
  const response = await send(descentProviderUrl(url), { redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new CreatorError("Descent video download failed", 502);
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "video/mp4") throw new CreatorError("Expected MP4 content", 422);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_DESCENT_VIDEO_BYTES)) throw new CreatorError("Descent video exceeds storage limit", 413);
  if (!response.body) throw new CreatorError("Empty descent video", 422);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DESCENT_VIDEO_BYTES) throw new CreatorError("Descent video exceeds storage limit", 413);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = Buffer.concat(chunks, total);
  if (length !== null && total !== Number(length)) throw new CreatorError("Incomplete descent video", 422);
  validateDescentMp4(bytes);
  return bytes;
}

export async function storeDescentVideo(input: { session_id: string; node_id: string; parent_node_id: string; parent_image_key: string; node_image_key: string; url: string }): Promise<StoredDescentVideo> {
  const bytes = await downloadDescentVideo(input.url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `${input.session_id}/descent-videos/${input.node_id}/${sha256}.mp4`;
  await uploadJpeg(key, bytes, "video/mp4", AbortSignal.timeout(90_000));
  return { version: 1, key, sha256, bytes: bytes.length, content_type: "video/mp4", parent_node_id: input.parent_node_id, parent_image_key: input.parent_image_key, node_image_key: input.node_image_key };
}

export function validStoredDescentVideo(value: StoredDescentVideo): boolean {
  return value.version === 1 && value.content_type === "video/mp4" && typeof value.key === "string" && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 32 && value.bytes <= MAX_DESCENT_VIDEO_BYTES && /^[A-Za-z0-9_-]+\/descent-videos\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.mp4$/.test(value.key) && value.key.endsWith(`/${value.sha256}.mp4`);
}

export function descentByteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new CreatorError("Invalid video range", 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start || (!match[1] && Number(match[2]) <= 0)) throw new CreatorError("Invalid video range", 416);
  return { start, end };
}
