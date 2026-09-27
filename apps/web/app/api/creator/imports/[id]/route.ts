import { checkCreatorWrite, creatorRoute } from "@/lib/creator";
import { CreatorError } from "@/lib/creator-error";
import { applyWorldImport, readWorldImport } from "@/lib/world-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ id: string }> }
export async function GET(_req: Request, { params }: Params) { return creatorRoute(async () => readWorldImport((await params).id)); }
export async function POST(req: Request, { params }: Params) {
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const raw = await req.text(); if (raw.length > 1024) throw new CreatorError("Import confirmation is too large", 413);
    let body; try { body = JSON.parse(raw); } catch { throw new CreatorError("Invalid import confirmation", 400); }
    if (body?.action !== "apply") throw new CreatorError("Confirm the import preview", 400);
    return applyWorldImport((await params).id, body.sha256);
  });
}
