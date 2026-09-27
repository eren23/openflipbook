import { creatorRoute } from "@/lib/creator";
import { sketchSource } from "@/lib/sketch-server";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    return await sketchSource((await ctx.params).id);
  } catch (error) {
    return creatorRoute(async () => {
      throw error;
    });
  }
}
