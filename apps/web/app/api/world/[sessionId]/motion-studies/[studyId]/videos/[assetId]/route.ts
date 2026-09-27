import { CreatorError } from "@/lib/creator";
import { motionVideoBytes } from "@/lib/motion-job-server";
import { motionPlaybackResponse } from "@/lib/motion-playback";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; studyId: string; assetId: string }> }) {
  const p = await params;
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  try { const bytes = await motionVideoBytes(p.sessionId, p.studyId, p.assetId); return motionPlaybackResponse(req, bytes); }
  catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503, headers }); }
}
