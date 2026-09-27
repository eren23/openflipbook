import { creatorRoute } from "@/lib/creator";
import { restoreSketch } from "@/lib/sketch-server";
export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  creatorRoute(async () => restoreSketch((await ctx.params).id, req));
