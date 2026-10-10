import { creatorRoute } from "@/lib/creator";
import { imageLedMedia } from "@/lib/image-led-walk-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ sessionId: string; walkId: string; file: string }> }) { let response: Response | undefined; const error = await creatorRoute(async () => { const p = await ctx.params; response = await imageLedMedia(req, p.sessionId, p.walkId, p.file); return {}; }); return response ?? error; }
