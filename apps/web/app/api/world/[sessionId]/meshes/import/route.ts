import { checkCreatorOrigin, creatorRoute, CreatorError, requireCreator } from "@/lib/creator";
import { MAX_MESH_BYTES } from "@/lib/mesh-asset";
import { importMesh } from "@/lib/mesh-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return creatorRoute(async () => {
    checkCreatorOrigin(req); await requireCreator(sessionId);
    if (!["model/gltf-binary", "application/octet-stream"].includes(req.headers.get("content-type") ?? "")) throw new CreatorError("Expected a binary GLB file", 415);
    let filename: string;
    try { filename = decodeURIComponent(req.headers.get("x-mesh-filename") ?? ""); } catch { throw new CreatorError("Invalid mesh filename", 400); }
    if (!filename || filename.length > 500) throw new CreatorError("Invalid mesh filename", 400);
    if (!req.body) throw new CreatorError("Empty GLB upload", 400);
    if (Number(req.headers.get("content-length")) > MAX_MESH_BYTES) throw new CreatorError("GLB exceeds 80 MiB", 413);
    const chunks: Uint8Array[] = [], reader = req.body.getReader(); let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_MESH_BYTES) { await reader.cancel(); throw new CreatorError("GLB exceeds 80 MiB", 413); } chunks.push(value);
    }
    return importMesh(sessionId, Buffer.concat(chunks), filename);
  });
}
