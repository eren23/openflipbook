import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { applyPlaceScene, previewPlaceScene, readPlaceScene } from "@/lib/place-scene-server";
import { getStoredBytes } from "@/lib/r2";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params;
  if (new URL(_req.url).searchParams.get("source") === "1") {
    try {
      const { scene } = await readPlaceScene(p.sessionId, p.geoId);
      const image = scene?.source_image_key ? await getStoredBytes(scene.source_image_key) : null;
      if (!image || !image.contentType.startsWith("image/") || image.bytes.length > 20 * 1024 * 1024) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(image.bytes), { headers: { "Content-Type": image.contentType, "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
    } catch (e) { return new Response(null, { status: e instanceof CreatorError ? e.status : 503 }); }
  }
  return creatorRoute(() => readPlaceScene(p.sessionId, p.geoId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const text = await req.text();
    if (text.length > 150_000) throw new CreatorError("Proposal too large", 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (!body || typeof body !== "object") throw new CreatorError("Invalid request", 400);
    if (body.action === "preview") return previewPlaceScene(p.sessionId, p.geoId, body);
    if (body.action === "apply") return applyPlaceScene(p.sessionId, p.geoId, body.proposal_id);
    throw new CreatorError("Unknown scene action", 400);
  });
}
