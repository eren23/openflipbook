import { CreatorError } from "@/lib/creator";
import { motionStudyFrame } from "@/lib/motion-study-server";
import type { ViewPass } from "@/lib/place-view";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; studyId: string; frame: string; pass: string }> }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  try {
    const p = await params;
    if (!/^(0|[1-9][0-9]?)$/.test(p.frame)) throw new CreatorError("Invalid motion frame", 400);
    const bytes = await motionStudyFrame(p.sessionId, p.studyId, Number(p.frame), p.pass as ViewPass);
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "image/png" } });
  } catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503, headers }); }
}
