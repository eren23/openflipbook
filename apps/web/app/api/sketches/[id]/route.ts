import { creatorRoute, checkCreatorWrite } from "@/lib/creator";
import { readSketch, saveSketch, deleteSketch } from "@/lib/sketch-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export const GET = (_req: Request, ctx: Context) =>
  creatorRoute(async () => readSketch((await ctx.params).id));
export const PUT = (req: Request, ctx: Context) =>
  creatorRoute(async () => saveSketch((await ctx.params).id, req));
export const DELETE = (req: Request, ctx: Context) =>
  creatorRoute(async () => {
    checkCreatorWrite(req);
    return deleteSketch((await ctx.params).id);
  });
