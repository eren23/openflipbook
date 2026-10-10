import { publicationZip } from "@/lib/world-publication";
import { CreatorError } from "@/lib/creator-error";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const bytes = await publicationZip((await params).id); return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=published-world.zip", "Cache-Control": "no-store" } }); }
  catch (e) { return Response.json({ error: e instanceof CreatorError ? e.message : "Export unavailable" }, { status: e instanceof CreatorError ? e.status : 503 }); }
}
