import { creatorRoute } from "@/lib/creator";
import { savedPlaceContext, sceneContext } from "@/lib/place-scene-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.has("world")) return creatorRoute(() => savedPlaceContext(url.searchParams.get("world") ?? "", url.searchParams.get("place") ?? ""));
  return creatorRoute(() => sceneContext(url.searchParams.get("source") ?? "", url.searchParams.get("place") ?? undefined, url.searchParams.get("draft") ?? undefined));
}
