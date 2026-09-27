import { creatorJson, CreatorError, requireCreator } from "@/lib/creator";
import { meshSourceBytes, readMeshSource } from "@/lib/mesh-source";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; sourceId: string }> }) {
  try {
    const { sessionId, sourceId } = await params, db = await requireCreator(sessionId);
    const bytes = await meshSourceBytes(await readMeshSource(db, sessionId, sourceId));
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return creatorJson({ error: error instanceof CreatorError ? error.message : "Concept image unavailable" }, error instanceof CreatorError ? error.status : 503); }
}
