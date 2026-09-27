import { creatorRoute } from "@/lib/creator";
import { meshBytes } from "@/lib/mesh-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; assetId: string }> }) {
  const p = await params;
  let bytes: Buffer | undefined;
  const error = await creatorRoute(async () => { bytes = await meshBytes(p.sessionId, p.assetId, "illustration"); return {}; });
  const contentType = bytes?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : "image/jpeg";
  return bytes ? new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } }) : error;
}
