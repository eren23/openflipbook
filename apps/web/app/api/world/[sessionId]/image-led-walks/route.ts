import { checkCreatorWrite, creatorRoute } from "@/lib/creator";
import { createImageLedWalk, imageLedLibrary } from "@/lib/image-led-walk-server";
import { readImageLedJson } from "@/lib/image-led-walk-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };
export async function GET(req: Request, ctx: Context) { return creatorRoute(async () => imageLedLibrary((await ctx.params).sessionId, new URL(req.url).searchParams.get("source_node_id") ?? undefined)); }
export async function POST(req: Request, ctx: Context) { return creatorRoute(async () => { checkCreatorWrite(req); return createImageLedWalk((await ctx.params).sessionId, await readImageLedJson(req)); }); }
