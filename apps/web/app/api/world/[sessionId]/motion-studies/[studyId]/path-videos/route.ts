import { checkCreatorWrite, creatorRoute, CreatorError, requireCreator } from "@/lib/creator";
import { pathVideoAction, pathVideoLibrary } from "@/lib/path-video";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; studyId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => pathVideoLibrary(p.sessionId, p.studyId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); await requireCreator(p.sessionId);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing path video action", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 16 * 1024) { await reader.cancel(); throw new CreatorError("Path video action too large", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid path video action JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid path video action", 400);
    return pathVideoAction(p.sessionId, p.studyId, input);
  });
}
