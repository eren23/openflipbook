import { checkCreatorWrite, creatorRoute, requireCreator, updateCreatorWorld } from "@/lib/creator";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ sessionId: string }> };
export async function GET(_req: Request, { params }: Params) {
  return creatorRoute(async () => { await requireCreator((await params).sessionId); return { owner: true }; });
}
export async function PATCH(req: Request, { params }: Params) {
  return creatorRoute(async () => { checkCreatorWrite(req); return updateCreatorWorld((await params).sessionId, await req.json().catch(() => null)); });
}
