import { creatorRoute } from "@/lib/creator";
import { illustrationRawBytes } from "@/lib/illustration-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ sessionId: string; viewId: string; jobId: string; index: string }> }) {
  const p = await context.params;
  let raw: Awaited<ReturnType<typeof illustrationRawBytes>> | undefined;
  const error = await creatorRoute(async () => { raw = await illustrationRawBytes(p.sessionId, p.viewId, p.jobId, p.index); return {}; });
  if (!raw) return error;
  return new Response(new Uint8Array(raw.bytes), { headers: { "Content-Type": raw.content_type, "Content-Length": String(raw.bytes.length),
    "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff", ETag: `"${raw.sha256}"` } });
}
