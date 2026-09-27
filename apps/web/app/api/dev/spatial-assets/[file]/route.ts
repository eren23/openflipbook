import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spatialAssetPath } from "@/lib/spatial-study";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (process.env.SPATIAL_STUDY !== "1" || process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const { file } = await params;
  const path = spatialAssetPath(file);
  if (!path) return new Response(null, { status: 404 });
  try {
    const data = await readFile(resolve(process.cwd(), "../modal-backend", path));
    const type = file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    const headers: Record<string, string> = { "Content-Type": type, "Content-Length": String(data.length), "Cache-Control": file.endsWith(".json") ? "no-store" : "private, max-age=3600" };
    if (file.endsWith(".mp4")) {
      headers["Accept-Ranges"] = "bytes";
      const range = request.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const suffix = match?.[1] === "";
        const start = suffix ? Math.max(0, data.length - Number(match?.[2])) : Number(match?.[1]);
        const end = suffix || match?.[2] === "" ? data.length - 1 : Math.min(data.length - 1, Number(match?.[2]));
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= data.length) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${data.length}`, "Accept-Ranges": "bytes" } });
        }
        headers["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
        headers["Content-Length"] = String(end - start + 1);
        return new Response(data.subarray(start, end + 1), { status: 206, headers });
      }
    }
    return new Response(data, { headers });
  } catch { return new Response(null, { status: 404 }); }
}
