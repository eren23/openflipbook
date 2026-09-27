import { creatorRoute } from "@/lib/creator";
import { discardSketchCandidate } from "@/lib/sketch-server";
export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  creatorRoute(async () => discardSketchCandidate((await ctx.params).id, req));
