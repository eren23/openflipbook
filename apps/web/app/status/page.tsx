import { readServerEnv } from "@/lib/env";
import { listRecentErrors } from "@/lib/db";

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
  providers?: { fal?: boolean; openrouter?: boolean };
  error?: string;
}

async function fetchBackendStatus(): Promise<BackendStatus | null> {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) return null;
  try {
    const res = await fetch(`${modalUrl.replace(/\/$/, "")}/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return (await res.json()) as BackendStatus;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function buildRows(env: ReturnType<typeof readServerEnv>): Row[] {
  return [
    {
      key: "MODAL_API_URL",
      required: true,
      ok: Boolean(env.MODAL_API_URL),
      hint: "URL printed by `modal deploy generate.py`.",
    },
    {
      key: "MONGODB_URI + MONGODB_DB",
      required: true,
      ok: Boolean(env.MONGODB_URI && env.MONGODB_DB),
      hint: "MongoDB connection string + database name for the node graph.",
    },
    {
      key: "R2_ACCOUNT_ID + R2_BUCKET + R2 keys",
      required: true,
      ok: Boolean(
        env.R2_ACCOUNT_ID &&
          env.R2_ACCESS_KEY_ID &&
          env.R2_SECRET_ACCESS_KEY &&
          env.R2_BUCKET &&
          env.R2_PUBLIC_BASE_URL
      ),
      hint: "Cloudflare R2 for generated image blobs.",
    },
    {
      key: "NEXT_PUBLIC_LTX_WS_URL",
      required: false,
      ok: Boolean(process.env.NEXT_PUBLIC_LTX_WS_URL),
      hint: "Optional: WS URL from `modal deploy ltx_stream.py` for the self-hosted streaming path. If unset, /play falls back to the cheap fal-ai/ltx-video clip.",
    },
  ];
}

export default async function StatusPage() {
  const env = readServerEnv();
  const rows = buildRows(env);
  const allRequired = rows.filter((r) => r.required).every((r) => r.ok);

  const [backend, recentErrors] = await Promise.all([
    fetchBackendStatus(),
    env.MONGODB_URI && env.MONGODB_DB
      ? listRecentErrors(20).catch(() => [])
      : Promise.resolve([]),
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
          ? "All required env vars are set — /play should generate pages."
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
          <li>uptime: {backend.uptime_s ?? "—"}s</li>
          <li>in-flight: {backend.in_flight ?? 0}</li>
          <li className="col-span-2 opacity-70">
            version <code>{backend.version ?? "dev"}</code>
          </li>
        </ul>
      )}

      <h2 className="mt-10 text-xl font-semibold">Recent errors</h2>
      {recentErrors.length === 0 ? (
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
