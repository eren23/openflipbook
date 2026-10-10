import { CreatorError } from "@/lib/creator-error";
import { publicationFile } from "@/lib/world-publication";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try { const { id, fileId } = await params, file = await publicationFile(id, fileId);
    return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.content_type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return Response.json({ error: e instanceof CreatorError ? e.message : "Published media unavailable" }, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "no-store" } }); }
}
