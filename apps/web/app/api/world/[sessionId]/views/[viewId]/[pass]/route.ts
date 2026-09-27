import { CreatorError } from "@/lib/creator";
import { placeViewBytes } from "@/lib/place-view-server";
import type { ViewPass } from "@/lib/place-view";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; viewId: string; pass: string }> }) {
  try {
    const p = await params, bytes = await placeViewBytes(p.sessionId, p.viewId, p.pass as ViewPass);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } }); }
}
