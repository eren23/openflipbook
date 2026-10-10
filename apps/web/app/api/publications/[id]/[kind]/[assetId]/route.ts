import { CreatorError } from "@/lib/creator-error";
import { publicationFile, readPublication } from "@/lib/world-publication";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; kind: string; assetId: string }> }) {
  try { const { id, kind, assetId } = await params;
    if (!["meshes", "materials"].includes(kind)) throw new CreatorError("Published asset not found", 404);
    const world = await readPublication(id), asset = world.assets.find(x => x.id === assetId && x.kind === (kind === "meshes" ? "mesh" : "material"));
    if (!asset) throw new CreatorError("Published asset not found", 404);
    const file = await publicationFile(id, asset.file_id);
    return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.content_type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return Response.json({ error: e instanceof CreatorError ? e.message : "Published asset unavailable" }, { status: e instanceof CreatorError ? e.status : 503, headers: { "Cache-Control": "no-store" } }); }
}
