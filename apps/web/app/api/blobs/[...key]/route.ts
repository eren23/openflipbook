import { NextResponse } from "next/server";
import { getStoredBytes } from "@/lib/r2";
import { requireStoredImageRead } from "@/lib/stored-image-access";
import { worldReadHeaders } from "@/lib/world-read-response";
import { CreatorError } from "@/lib/creator-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const key = (await params).key.join("/");
    await requireStoredImageRead(key);
    const stored = await getStoredBytes(key, AbortSignal.timeout(30_000));
    if (!stored) return new Response(null, { status: 404, headers: worldReadHeaders });
    if (!["image/jpeg", "image/png", "image/webp"].includes(stored.contentType) || stored.bytes.length > 20 * 1024 * 1024) return new Response(null, { status: 422, headers: worldReadHeaders });
    return new Response(new Uint8Array(stored.bytes), { headers: { ...worldReadHeaders, "Content-Type": stored.contentType, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof CreatorError ? error.message : "Stored image unavailable" }, {
      status: error instanceof CreatorError ? error.status : 503, headers: worldReadHeaders,
    });
  }
}
