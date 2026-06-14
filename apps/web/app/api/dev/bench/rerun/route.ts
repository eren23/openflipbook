import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const BENCH_ENABLED = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_BENCH_UI ?? "").toLowerCase()
);

export async function POST(req: Request) {
  if (!BENCH_ENABLED) {
    return NextResponse.json({ error: "bench UI disabled" }, { status: 404 });
  }
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "rerun disabled in production" }, { status: 403 });
  }

  const body = (await req.json()) as { sweep?: string };
  const sweep = body.sweep ?? "tests/scenario_lab/sweeps/layout.json";
  const backendDir = path.resolve(process.cwd(), "../modal-backend");
  const python = path.join(backendDir, ".venv/bin/python");

  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      ["-m", "tests.scenario_lab.runner"],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          MATRIX_SWEEP: sweep,
          MATRIX_BENCH_RUN: "1",
          MATRIX_ALLOW_PARTIAL: "1",
        },
        timeout: 300_000,
      }
    );
    return NextResponse.json({ ok: true, stdout, stderr });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json(
      { ok: false, error: e.message ?? "rerun failed", stdout: e.stdout, stderr: e.stderr },
      { status: 500 }
    );
  }
}
