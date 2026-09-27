import { creatorRoute } from "@/lib/creator";
import { createSketch, listSketches } from "@/lib/sketch-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = () => creatorRoute(listSketches);
export async function POST(req: Request) {
  try {
    return await createSketch(req);
  } catch (error) {
    return creatorRoute(async () => {
      throw error;
    });
  }
}
