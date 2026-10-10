import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { importLocalIllustration, LOCAL_IMPORT_BODY_LIMIT } from "@/lib/illustration-local-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; viewId: string }> }
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing local draft import", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > LOCAL_IMPORT_BODY_LIMIT) { await reader.cancel(); throw new CreatorError("Local draft import is too large", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input: unknown; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid local import JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid local import request", 400);
    return importLocalIllustration(p.sessionId, p.viewId, input as Record<string, unknown>);
  });
}
