import { checkCreatorWrite, creatorRoute, readCreatorNotes, saveCreatorNote } from "@/lib/creator";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ sessionId: string }> };
export async function GET(_req: Request, { params }: Params) {
  return creatorRoute(async () => readCreatorNotes((await params).sessionId));
}
export async function PUT(req: Request, { params }: Params) {
  return creatorRoute(async () => { checkCreatorWrite(req); return saveCreatorNote((await params).sessionId, await req.json().catch(() => null)); });
}
