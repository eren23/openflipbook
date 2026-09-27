import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { placeViewLibrary, savePlaceView } from "@/lib/place-view-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => placeViewLibrary(p.sessionId, p.geoId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing view JSON", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new CreatorError("View capture exceeds 20 MiB", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    let input; try { input = JSON.parse(text); } catch { throw new CreatorError("Invalid view JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid view", 400);
    return savePlaceView(p.sessionId, p.geoId, input);
  });
}
