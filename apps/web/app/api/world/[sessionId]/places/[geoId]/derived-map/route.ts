import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { saveGeometryMapView } from "@/lib/map-artwork-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const text = await req.text();
    if (text.length > 18 * 1024 * 1024) throw new CreatorError("Map capture exceeds 18 MiB", 413);
    let input;
    try { input = JSON.parse(text); } catch { throw new CreatorError("Invalid map capture JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid map capture", 400);
    return saveGeometryMapView(p.sessionId, p.geoId, input);
  });
}
