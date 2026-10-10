import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { sceneEditAction, sceneEditLibrary } from "@/lib/scene-text-edit-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const { sessionId, geoId } = await params; return creatorRoute(() => sceneEditLibrary(sessionId, geoId));
}
export async function POST(req: Request, { params }: Params) {
  const { sessionId, geoId } = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); const text = await req.text(); if (text.length > 8000) throw new CreatorError("Scene edit request too large", 413);
    let body; try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CreatorError("Invalid scene edit request", 400);
    return sceneEditAction(sessionId, geoId, body);
  });
}
