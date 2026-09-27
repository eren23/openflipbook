import { checkCreatorOrigin, creatorRoute } from "@/lib/creator";
import { CreatorError } from "@/lib/creator-error";
import { inspectWorldImport } from "@/lib/world-import";
import { WORLD_IMPORT_BYTES } from "@/lib/world-import-archive";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return creatorRoute(async () => {
    checkCreatorOrigin(req);
    if (!req.headers.get("content-type")?.includes("application/zip")) throw new CreatorError("Choose a world ZIP archive", 415);
    if (!req.body || Number(req.headers.get("content-length")) > WORLD_IMPORT_BYTES) throw new CreatorError("Archive exceeds 384 MiB", 413);
    const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
        if (size > WORLD_IMPORT_BYTES) { await reader.cancel(); throw new CreatorError("Archive exceeds 384 MiB", 413); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    return inspectWorldImport(new URL(req.url).searchParams.get("request_id") ?? "", Buffer.concat(chunks, size));
  });
}
