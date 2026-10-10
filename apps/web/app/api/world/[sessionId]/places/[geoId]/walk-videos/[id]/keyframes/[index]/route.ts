import { CreatorError } from "@/lib/creator-error";
import { walkVideoKeyframeBytes } from "@/lib/path-video";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; geoId: string; id: string; index: string }> }) {
  try { const p = await params, file = await walkVideoKeyframeBytes(p.sessionId, p.geoId, p.id, p.index);
    return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.content_type, "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return Response.json({ error: e instanceof CreatorError ? e.message : "Preserved keyframe unavailable" }, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
}
