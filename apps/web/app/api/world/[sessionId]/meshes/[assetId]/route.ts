import { CreatorError } from "@/lib/creator";
import { meshBytes, meshDimensions } from "@/lib/mesh-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, {params}: {params: Promise<{sessionId: string; assetId: string}>}) {
  try {
    const {sessionId, assetId} = await params;
    if (new URL(_req.url).searchParams.get("geometry") === "1") return Response.json({ size: await meshDimensions(sessionId, assetId) }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    return new Response(new Uint8Array(await meshBytes(sessionId, assetId)), {headers: {"Content-Type": "model/gltf-binary", "Cache-Control": "private, max-age=3600", Vary: "Cookie", "X-Content-Type-Options": "nosniff"}});
  } catch (e) {return Response.json({ error: e instanceof CreatorError ? e.message : "Saved mesh unavailable" }, {status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" }});}
}
