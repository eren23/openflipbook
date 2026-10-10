import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { getOrCreateOwnerToken } from "@/lib/session-owner";
import { forkPublication } from "@/lib/world-publication";
export const runtime = "nodejs";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return creatorRoute(async () => { checkCreatorWrite(req); const text = await req.text();
    if (text.length > 4096) throw new CreatorError("Fork request too large", 413);
    let body; try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid fork request", 400); }
    if (!body || typeof body.request_id !== "string") throw new CreatorError("Fork identity required", 400);
    await getOrCreateOwnerToken(); return forkPublication((await params).id, body.request_id);
  });
}
