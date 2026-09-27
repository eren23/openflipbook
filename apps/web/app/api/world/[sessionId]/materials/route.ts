import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { meshLibrary, submitMesh, refreshMesh, cancelMesh } from "@/lib/mesh-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params; return creatorRoute(() => meshLibrary(sessionId, "material"));
}
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); const text = await req.text();
    if (text.length > 8000) throw new CreatorError("Material request too large", 413);
    let body; try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (body?.action === "generate") return submitMesh(sessionId, body, "material");
    if (body?.action === "refresh") return refreshMesh(sessionId, body.id, "material");
    if (body?.action === "cancel") return cancelMesh(sessionId, body.id, "material");
    throw new CreatorError("Unknown material action", 400);
  });
}
