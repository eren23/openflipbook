import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { meshLibrary, submitMesh, refreshMesh, cancelMesh } from "@/lib/mesh-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params {params: Promise<{sessionId: string}>}
export async function GET(_req: Request, {params}: Params) {const {sessionId} = await params; return creatorRoute(() => meshLibrary(sessionId));}
export async function POST(req: Request, {params}: Params) {
  const {sessionId} = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); const text = await req.text();
    if (text.length > 8000) throw new CreatorError("Mesh request too large", 413);
    let body; try {body = JSON.parse(text);} catch {throw new CreatorError("Invalid JSON", 400);}
    if (body?.action === "generate") return submitMesh(sessionId, body);
    if (body?.action === "refresh") return refreshMesh(sessionId, body.id);
    if (body?.action === "cancel") return cancelMesh(sessionId, body.id);
    throw new CreatorError("Unknown mesh action", 400);
  });
}
