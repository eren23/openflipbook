import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { LOCAL_VERIFICATION_BODY_LIMIT, quoteLocalIllustrationVerification, verifyLocalIllustration } from "@/lib/illustration-local-verify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; viewId: string }> }
export async function GET(req: Request, { params }: Params) {
  const p = await params, url = new URL(req.url);
  return creatorRoute(() => {
    const source = [p.sessionId, p.viewId, url.searchParams.get("asset_id") ?? "", url.searchParams.get("asset_sha256") ?? ""] as const;
    return url.searchParams.has("segmentation_profile") ? quoteLocalIllustrationVerification(...source, url.searchParams.get("segmentation_profile")) : quoteLocalIllustrationVerification(...source);
  });
}
export async function POST(req: Request, { params }: Params) {
  const p = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    const reader = req.body?.getReader(); if (!reader) throw new CreatorError("Missing local verification request", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > LOCAL_VERIFICATION_BODY_LIMIT) { await reader.cancel(); throw new CreatorError("Local verification request is too large", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let input: unknown; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CreatorError("Invalid local verification JSON", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("Invalid local verification request", 400);
    return verifyLocalIllustration(p.sessionId, p.viewId, input as Record<string, unknown>);
  });
}
