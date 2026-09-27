import { checkCreatorWrite, creatorRoute, CreatorError, requireCreator } from "@/lib/creator";
import { meshSources, saveMeshSource, MAX_MESH_SOURCE_BYTES } from "@/lib/mesh-source";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params; return creatorRoute(() => meshSources(sessionId));
}
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); await requireCreator(sessionId);
    const limit = MAX_MESH_SOURCE_BYTES * 4 / 3 + 4096;
    if (Number(req.headers.get("content-length")) > limit || !req.body) throw new CreatorError("Concept upload too large", 413);
    const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw new CreatorError("Concept upload too large", 413); } chunks.push(value);
    }
    let input; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid concept input", 400);
    return saveMeshSource(sessionId, input);
  });
}
