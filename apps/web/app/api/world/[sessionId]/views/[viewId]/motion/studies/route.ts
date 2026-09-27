import { checkCreatorWrite, creatorRoute, CreatorError, requireCreator } from "@/lib/creator";
import { motionStudyLibrary, saveMotionStudy } from "@/lib/motion-study-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; viewId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => motionStudyLibrary(p.sessionId, p.viewId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    // References contain several images. Reject non-owners before buffering.
    await requireCreator(p.sessionId);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing motion study", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 80 * 1024 * 1024) { await reader.cancel(); throw new CreatorError("Motion study request exceeds 80 MiB", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid motion study JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid motion study", 400);
    return saveMotionStudy(p.sessionId, p.viewId, input);
  });
}
