import { creatorRoute } from "@/lib/creator";
import { acceptSketch } from "@/lib/sketch-server";
export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  creatorRoute(async () => acceptSketch((await ctx.params).id, req));
