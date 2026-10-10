import { creatorRoute } from "@/lib/creator";
import { imageLedSourceMedia } from "@/lib/image-led-walk-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ sessionId: string; nodeId: string }> }) { let response: Response | undefined; const error = await creatorRoute(async () => { const p = await ctx.params; response = await imageLedSourceMedia(req, p.sessionId, p.nodeId); return {}; }); return response ?? error; }
