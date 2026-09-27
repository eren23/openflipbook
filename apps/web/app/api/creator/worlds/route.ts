import { checkCreatorWrite, CreatorError, creatorRoute, listCreatorWorlds } from "@/lib/creator";
import { createPlaceWorld } from "@/lib/place-scene-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return creatorRoute(() => listCreatorWorlds(new URL(req.url)));
}
export async function POST(req: Request) {
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const text = await req.text();
    if (text.length > 150_000) throw new CreatorError("World definition too large", 413);
    let input;
    try { input = JSON.parse(text); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid world", 400);
    return createPlaceWorld(input);
  });
}
