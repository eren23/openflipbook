import { CreatorError } from "@/lib/creator";
import { meshBytes } from "@/lib/mesh-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; assetId: string }> }) {
  try {
    const { sessionId, assetId } = await params;
    return new Response(new Uint8Array(await meshBytes(sessionId, assetId, "material")), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
}
