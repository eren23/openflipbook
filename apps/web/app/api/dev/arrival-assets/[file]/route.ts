import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { arrivalAssetPath } from "@/lib/arrival-study";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (process.env.SPATIAL_STUDY !== "1" || process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const path = arrivalAssetPath((await params).file);
  if (!path) return new Response(null, { status: 404 });
  try {
    const data = await readFile(resolve(process.cwd(), "../modal-backend", path));
    return new Response(data, { headers: { "Content-Type": path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "private, no-store" } });
  } catch { return new Response(null, { status: 404 }); }
}
