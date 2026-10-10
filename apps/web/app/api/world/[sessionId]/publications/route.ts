import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { createPublication, publicationChoices, unpublishWorld } from "@/lib/world-publication";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string }> }
export async function GET(_req: Request, { params }: Params) { return creatorRoute(async () => publicationChoices((await params).sessionId)); }
export async function POST(req: Request, { params }: Params) {
  return creatorRoute(async () => {
    checkCreatorWrite(req); const text = await req.text();
    if (text.length > 16 * 1024) throw new CreatorError("Publication request is too large", 413);
    let body; try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid publication JSON", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CreatorError("Invalid publication request", 400);
    return createPublication((await params).sessionId, body);
  });
}
export async function DELETE(req: Request, { params }: Params) {
  return creatorRoute(async () => { checkCreatorWrite(req); return unpublishWorld((await params).sessionId, new URL(req.url).searchParams.get("id") ?? ""); });
}
