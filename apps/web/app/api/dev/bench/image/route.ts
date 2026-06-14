import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BENCH_ENABLED = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_BENCH_UI ?? "").toLowerCase()
);

// Cached cell artifacts live next to the scenario reports, under the matrix
// chassis cache: <cache>/<cell_key>/{image.jpg,source.jpg,poster.jpg}.
function cacheDir(): string {
  return (
    process.env.BENCH_CACHE_DIR ??
    path.resolve(process.cwd(), "../modal-backend/tests/matrix_bench/cache")
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export async function GET(req: Request) {
  if (!BENCH_ENABLED) {
    return NextResponse.json({ error: "bench UI disabled" }, { status: 404 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  const name = url.searchParams.get("name") ?? "image.jpg";

  // cell_key is a 20-char hex sha; the artifact name is a fixed basename. Both
  // are validated so nothing can escape the cell directory.
  if (!/^[a-f0-9]{8,40}$/.test(key)) {
    return NextResponse.json({ error: "bad key" }, { status: 400 });
  }
  const base = path.basename(name);
  const ext = path.extname(base).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (base !== name || !contentType) {
    return NextResponse.json({ error: "bad name" }, { status: 400 });
  }

  const root = cacheDir();
  const file = path.join(root, key, base);
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}
