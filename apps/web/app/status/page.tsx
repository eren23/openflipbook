import { readServerEnv, requireR2 } from "@/lib/env";
import { getDb, listRecentErrors } from "@/lib/db";
import { modalAuthHeaders, modalUrl } from "@/lib/modal";
import { storedBucketReachable } from "@/lib/r2";
import { debugAccessAllowed } from "@/lib/debug-access";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

interface Row {
  key: string;
  required: boolean;
  ok: boolean;
  hint: string;
}

interface BackendStatus {
  ok?: boolean;
  service?: string;
  version?: string;
  uptime_s?: number;
  in_flight?: number;
  last_error_ts?: number | null;
  providers?: { fal?: boolean; openrouter?: boolean; requesty?: boolean };
  error?: string;
}

async function fetchBackendStatus(): Promise<BackendStatus | null> {
  const base = process.env.MODAL_API_URL;
  if (!base) return null;
  try {
    const res = await fetch(modalUrl(base, "/status"), {
      cache: "no-store",
      headers: modalAuthHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return (await res.json()) as BackendStatus;
  } catch {
    return { error: "Request failed or timed out" };
  }
}

function buildRows(env: ReturnType<typeof readServerEnv>): Row[] {
  let storageConfigured = false;
  try { requireR2(env); storageConfigured = true; } catch { /* shown as missing below */ }
  return [
    {
      key: "MODAL_API_URL",
      required: true,
      ok: Boolean(env.MODAL_API_URL),
      hint: "Backend URL from Modal or the self-hosted API service.",
    },
    {
      key: "MONGODB_URI + MONGODB_DB",
      required: true,
      ok: Boolean(env.MONGODB_URI && env.MONGODB_DB),
      hint: "MongoDB connection string + database name for the node graph.",
    },
    {
      key: "R2_ENDPOINT or R2_ACCOUNT_ID + bucket + keys",
      required: true,
      ok: storageConfigured,
      hint: "Cloudflare R2 or a compatible S3 endpoint; use /api/blobs with a private bucket.",
    },
    {
      key: "NEXT_PUBLIC_LTX_WS_URL",
      required: false,
      ok: Boolean(process.env.NEXT_PUBLIC_LTX_WS_URL),
      hint: "Optional: WS URL from `modal deploy ltx_stream.py` for the self-hosted streaming path. If unset, /play falls back to a fal MiniMax H3 clip.",
    },
  ];
}

export default async function StatusPage() {
  const env = readServerEnv();
  const rows = buildRows(env);
  const allRequired = rows.filter((r) => r.required).every((r) => r.ok);

  const debugAllowed = debugAccessAllowed(new Request("http://localhost/status", { headers: await headers() }));
  const [backend, recentErrors, bucket, persistence] = await Promise.all([
    fetchBackendStatus(),
    debugAllowed && env.MONGODB_URI && env.MONGODB_DB
      ? listRecentErrors(20).catch(() => [])
      : Promise.resolve([]),
    storedBucketReachable(),
    env.MONGODB_URI && env.MONGODB_DB ? getDb().then(async db => {
      await db.command({ ping: 1 }, { timeoutMS: 4000 });
      const workers = await db.collection("generation_workers").countDocuments({ last_seen: { $gt: new Date(Date.now() - 30_000) } }, { maxTimeMS: 4000 });
      return { reachable: true, workers };
    }).catch(() => ({ reachable: false, workers: 0 })) : Promise.resolve({ reachable: false, workers: 0 }),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold">Environment status</h1>
      <p className="mt-2 text-sm opacity-70">
        Checks the server-side env this deploy is running with. Client secrets
        not shown.
      </p>

      <div
        className={`mt-6 rounded-xl border p-4 text-sm ${
          allRequired
            ? "border-green-600 bg-green-50 text-green-900"
            : "border-amber-600 bg-amber-50 text-amber-900"
        }`}
      >
        {allRequired
          ? "All required env vars are set. Backend health is checked below; generation also needs working providers and a worker."
          : "Some required env vars are missing. /play will show BYO-key errors."}
      </div>

      <ul className="mt-6 space-y-3">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-start justify-between gap-4 rounded-lg border border-[var(--color-ink)]/20 bg-white/70 p-4"
          >
            <div>
              <code className="font-mono text-sm">{r.key}</code>
              <p className="mt-1 text-xs opacity-70">{r.hint}</p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                r.ok
                  ? "bg-green-600 text-white"
                  : r.required
                    ? "bg-red-600 text-white"
                    : "bg-gray-300 text-black"
              }`}
            >
              {r.ok ? "set" : r.required ? "missing" : "not set"}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-xl font-semibold">Backend health</h2>
      {!backend ? (
        <p className="mt-2 text-sm opacity-70">
          MODAL_API_URL not set; backend health check skipped.
        </p>
      ) : backend.error ? (
        <p className="mt-2 text-sm text-red-700">
          Backend unreachable: {backend.error}
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <li>
            fal:{" "}
            <span
              className={
                backend.providers?.fal
                  ? "text-green-700"
                  : "text-amber-700"
              }
            >
              {backend.providers?.fal ? "ok" : "down"}
            </span>
          </li>
          <li>
            openrouter:{" "}
            <span
              className={
                backend.providers?.openrouter
                  ? "text-green-700"
                  : "text-amber-700"
              }
            >
              {backend.providers?.openrouter ? "ok" : "down"}
            </span>
          </li>
          {backend.providers?.requesty !== undefined && (
            <li>
              requesty:{" "}
              <span
                className={
                  backend.providers?.requesty
                    ? "text-green-700"
                    : "text-amber-700"
                }
              >
                {backend.providers?.requesty ? "ok" : "down"}
              </span>
            </li>
          )}
          <li>uptime: {backend.uptime_s ?? "—"}s</li>
          <li>in-flight: {backend.in_flight ?? 0}</li>
          <li className="col-span-2 opacity-70">
            version <code>{backend.version ?? "dev"}</code>
          </li>
        </ul>
      )}

      <h2 className="mt-10 text-xl font-semibold">Stores and workers</h2>
      <ul className="mt-3 space-y-2 text-sm">
        <li>MongoDB: {persistence.reachable ? "reachable" : "unreachable or not configured"}</li>
        <li>Private bucket: {bucket ? "reachable" : "unreachable or not configured"}</li>
        <li>Worker heartbeat: {persistence.workers ? "fresh" : "no fresh worker"}</li>
      </ul>
      <p className="mt-2 text-xs opacity-70">These checks do not submit model jobs. Individual generation features also require a compatible worker and configured provider quote.</p>

      <h2 className="mt-10 text-xl font-semibold">Recent errors</h2>
      {!debugAllowed ? <p className="mt-2 text-sm opacity-70">Operator debug access is required to view error details.</p> : recentErrors.length === 0 ? (
        <p className="mt-2 text-sm opacity-70">No errors logged.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-xs">
          {recentErrors.map((e, i) => (
            <li
              key={`${e.trace_id ?? "no-trace"}-${i}`}
              className="rounded-md border border-[var(--color-ink)]/15 bg-white/70 p-2"
            >
              <div className="flex justify-between gap-2">
                <code>{e.kind}</code>
                <span className="opacity-60">{e.ts}</span>
              </div>
              <div className="mt-1 break-words font-mono">{e.message}</div>
              {e.trace_id && (
                <div className="opacity-60">trace {e.trace_id}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-sm">
        See <code>docs/BYO-KEYS.md</code> for the full setup walkthrough.
      </p>
    </main>
  );
}
