import { checkCreatorWrite, CreatorError, creatorRoute } from "@/lib/creator";
import { getExistingOwnerToken } from "@/lib/session-owner";
import { redeemOwnerRecovery } from "@/lib/owner-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const tooLarge = () => new CreatorError("Recovery request is too large", 413);
    if (Number(req.headers.get("content-length")) > 1024) throw tooLarge();
    const chunks: Uint8Array[] = [], reader = req.body?.getReader(); let size = 0;
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); throw tooLarge(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid recovery request", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "code")) throw new CreatorError("Invalid recovery request", 400);
    return redeemOwnerRecovery((body as { code?: unknown }).code, await getExistingOwnerToken());
  });
}
