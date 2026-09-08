import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spatialAssetPath } from "@/lib/spatial-study";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (process.env.SPATIAL_STUDY !== "1" || process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const { file } = await params;
  const path = spatialAssetPath(file);
  if (!path) return new Response(null, { status: 404 });
  try {
    const data = await readFile(resolve(process.cwd(), "../modal-backend", path));
    return new Response(data, { headers: { "Content-Type": file.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "Cache-Control": "private, max-age=3600" } });
  } catch { return new Response(null, { status: 404 }); }
}
