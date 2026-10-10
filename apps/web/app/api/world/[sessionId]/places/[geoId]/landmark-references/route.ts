import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { landmarkReferenceAction } from "@/lib/illustration-landmarks-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(() => landmarkReferenceAction(p.sessionId, p.geoId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing map references", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new CreatorError("Map references exceed 16 KiB", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid map-reference JSON", 400); }
    return landmarkReferenceAction(p.sessionId, p.geoId, input);
  });
}
