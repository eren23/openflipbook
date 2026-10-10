import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getNode } from "@/lib/db";
import { requireCreator } from "@/lib/creator";
import { CreatorError } from "@/lib/creator-error";
import { descentByteRange, validStoredDescentVideo, validateDescentMp4 } from "@/lib/descent-video-store";
import { getStoredBytes } from "@/lib/r2";
import { worldReadHeaders } from "@/lib/world-read-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let size: number | null = null;
  try {
    const { id } = await params;
    const row = await getNode(id);
    if (!row) throw new CreatorError("Arrival clip not found", 404);
    await requireCreator(row.session_id);
    const video = row.descent_video;
    if (!video) throw new CreatorError("Arrival clip not found", 404);
    if (!validStoredDescentVideo(video)) throw new CreatorError("Invalid stored arrival clip", 422);
    size = video.bytes;
    // Without validating If-Range, send the complete immutable representation.
    const range = descentByteRange(req.headers.has("if-range") ? null : req.headers.get("range"), size);
    const stored = await getStoredBytes(video.key, AbortSignal.timeout(30_000));
    if (!stored) throw new CreatorError("Arrival clip not found", 404);
    if (stored.contentType !== "video/mp4" || stored.bytes.length !== video.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== video.sha256) throw new CreatorError("Stored arrival clip failed verification", 422);
    validateDescentMp4(stored.bytes);
    const body = range ? stored.bytes.subarray(range.start, range.end + 1) : stored.bytes;
    return new Response(new Uint8Array(body), { status: range ? 206 : 200, headers: {
      ...worldReadHeaders,
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": String(body.length),
      ETag: `"${video.sha256}"`,
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    } });
  } catch (error) {
    const status = error instanceof CreatorError ? error.status : 503;
    return NextResponse.json({ error: error instanceof CreatorError ? error.message : "Arrival clip unavailable" }, { status, headers: { ...worldReadHeaders, ...(status === 416 && size !== null ? { "Content-Range": `bytes */${size}` } : {}) } });
  }
}
