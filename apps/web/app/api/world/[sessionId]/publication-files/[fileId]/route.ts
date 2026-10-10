import { publicationLibraryFile } from "@/lib/world-publication";
import { CreatorError } from "@/lib/creator-error";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; fileId: string }> }) {
  try { const { sessionId, fileId } = await params, file = await publicationLibraryFile(sessionId, fileId);
    return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.content_type, "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return Response.json({ error: e instanceof CreatorError ? e.message : "Snapshot media unavailable" }, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
}
