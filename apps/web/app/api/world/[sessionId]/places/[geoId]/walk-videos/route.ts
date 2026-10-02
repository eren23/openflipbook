import { checkCreatorWrite, creatorRoute, CreatorError, requireCreator } from "@/lib/creator";
import { walkVideoAction, walkVideoLibrary } from "@/lib/path-video";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
// ?views=a,b,c quotes a walk video over those saved views, in order.
export async function GET(req: Request, { params }: Params) {
  const p = await params, views = new URL(req.url).searchParams.get("views");
  return creatorRoute(() => walkVideoLibrary(p.sessionId, p.geoId, views ? views.split(",").slice(0, 13) : null));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); await requireCreator(p.sessionId);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing walk video action", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 16 * 1024) { await reader.cancel(); throw new CreatorError("Walk video action too large", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid walk video action JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid walk video action", 400);
    return walkVideoAction(p.sessionId, p.geoId, input);
  });
}
