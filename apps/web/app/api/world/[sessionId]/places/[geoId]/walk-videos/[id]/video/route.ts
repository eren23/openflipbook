import { CreatorError } from "@/lib/creator";
import { walkVideoBytes } from "@/lib/path-video";
import { motionPlaybackResponse } from "@/lib/motion-playback";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; geoId: string; id: string }> }) {
  const p = await params;
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  try { return motionPlaybackResponse(req, await walkVideoBytes(p.sessionId, p.geoId, p.id)); }
  catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503, headers }); }
}
