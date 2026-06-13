import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BENCH_ENABLED = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_BENCH_UI ?? "").toLowerCase()
);

function reportsDir(): string {
  return (
    process.env.BENCH_REPORTS_DIR ??
    path.resolve(process.cwd(), "../modal-backend/tests/scenario_lab/reports")
  );
}

function scenariosDir(): string {
  return path.resolve(
    process.cwd(),
    "../modal-backend/tests/scenario_lab/scenarios"
  );
}

function guard() {
  if (!BENCH_ENABLED) {
    return NextResponse.json({ error: "bench UI disabled" }, { status: 404 });
  }
  return null;
}

function listRuns(dir: string): Array<{ name: string; mtime: string; path: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      return { name, mtime: st.mtime.toISOString(), path: p };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export async function GET(req: Request) {
  const blocked = guard();
  if (blocked) return blocked;

  const url = new URL(req.url);
  const run = url.searchParams.get("run");
  const dir = reportsDir();

  if (run) {
    const file = path.join(dir, run);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    return NextResponse.json({ report, run });
  }

  const scenarios = fs.existsSync(scenariosDir())
    ? fs.readdirSync(scenariosDir()).filter((f) => f.endsWith(".json"))
    : [];

  return NextResponse.json({
    runs: listRuns(dir),
    scenarios,
    reports_dir: dir,
  });
}
