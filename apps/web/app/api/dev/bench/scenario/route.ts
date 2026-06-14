import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BENCH_ENABLED = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_BENCH_UI ?? "").toLowerCase()
);

function scenariosDir(): string {
  return path.resolve(
    process.cwd(),
    "../modal-backend/tests/scenario_lab/scenarios"
  );
}

export async function GET(req: Request) {
  if (!BENCH_ENABLED) {
    return NextResponse.json({ error: "bench UI disabled" }, { status: 404 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const safe = id.replace(/\.json$/, "");
  const file = path.join(scenariosDir(), `${safe}.json`);
  const dir = scenariosDir();
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ data: JSON.parse(fs.readFileSync(file, "utf8")) });
}

export async function PUT(req: Request) {
  if (!BENCH_ENABLED) {
    return NextResponse.json({ error: "bench UI disabled" }, { status: 404 });
  }
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "save disabled in production" }, { status: 403 });
  }

  const body = (await req.json()) as { id: string; data: Record<string, unknown> };
  const dir = scenariosDir();
  const file = path.join(dir, `${body.id}.json`);
  if (!file.startsWith(dir)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body.data, null, 2) + "\n");
  return NextResponse.json({ ok: true });
}
