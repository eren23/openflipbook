import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { illustrationAction, illustrationLibrary } from "@/lib/illustration-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; viewId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => illustrationLibrary(p.sessionId, p.viewId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing illustration request", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new CreatorError("Illustration request exceeds 16 KiB", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid illustration JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid illustration request", 400);
    return illustrationAction(p.sessionId, p.viewId, input);
  });
}
