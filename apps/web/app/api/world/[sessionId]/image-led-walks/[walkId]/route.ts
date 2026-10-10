import { checkCreatorWrite, creatorRoute } from "@/lib/creator";
import { imageLedAction, imageLedDetail } from "@/lib/image-led-walk-server";
import { readImageLedJson } from "@/lib/image-led-walk-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string; walkId: string }> };
export async function GET(req: Request, ctx: Context) { return creatorRoute(async () => { const p = await ctx.params, url = new URL(req.url), index = url.searchParams.get("index"); return imageLedDetail(p.sessionId, p.walkId, url.searchParams.get("kind") ?? undefined, index === null ? undefined : Number(index)); }); }
export async function POST(req: Request, ctx: Context) { return creatorRoute(async () => { checkCreatorWrite(req); const p = await ctx.params; return imageLedAction(p.sessionId, p.walkId, await readImageLedJson(req)); }); }
