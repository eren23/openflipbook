"use client";

import { useCallback, useEffect, useState } from "react";

interface RunMeta {
  name: string;
  mtime: string;
}

interface CellRecord {
  cell_key?: string;
  label?: string;
  scenario_id?: string;
  arm?: string;
  model?: string;
  prompt_variant?: string;
  scores?: Record<string, number>;
  status?: string;
  est_usd?: number;
  error?: string;
  outputs?: { artifacts?: string[]; [k: string]: unknown };
}

function imgUrl(key: string, name = "image.jpg"): string {
  return `/api/dev/bench/image?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`;
}

// A cell has a viewable image once it has run (scores present) and isn't a
// dry-run "would_run" / "failed" row.
function hasImage(c: CellRecord): boolean {
  return Boolean(c.cell_key) && Boolean(c.scores) && c.status !== "failed";
}

function sourceArtifact(c: CellRecord): string | null {
  const arts = c.outputs?.artifacts ?? [];
  if (arts.includes("source.jpg")) return "source.jpg";
  if (arts.includes("poster.jpg")) return "poster.jpg";
  return null;
}

interface Report {
  sweep?: string;
  run_at?: string;
  to_bill_usd?: number;
  spent_usd?: number;
  cells?: CellRecord[];
}

export default function BenchGalleryPage() {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [scenarioId, setScenarioId] = useState<string>("");
  const [scenarioJson, setScenarioJson] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [disabled, setDisabled] = useState(false);

  const loadIndex = useCallback(async () => {
    const res = await fetch("/api/dev/bench");
    if (res.status === 404) {
      setDisabled(true);
      return;
    }
    const data = await res.json();
    setRuns(data.runs ?? []);
    setScenarios(data.scenarios ?? []);
  }, []);

  const loadRun = useCallback(async (name: string) => {
    setSelectedRun(name);
    const res = await fetch(`/api/dev/bench?run=${encodeURIComponent(name)}`);
    const data = await res.json();
    setReport(data.report ?? null);
  }, []);

  const loadScenario = useCallback(async (id: string) => {
    setScenarioId(id);
    const res = await fetch(`/api/dev/bench/scenario?id=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    setScenarioJson(JSON.stringify(data.data, null, 2));
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  const cells = (report?.cells ?? []).filter((c) => c.scores || c.label);

  const cellA = cells.find((c) => (c.label ?? c.cell_key) === diffA);
  const cellB = cells.find((c) => (c.label ?? c.cell_key) === diffB);

  async function handleRerun() {
    setStatus("running…");
    const res = await fetch("/api/dev/bench/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sweep: "tests/scenario_lab/sweeps/layout.json",
      }),
    });
    const data = await res.json();
    setStatus(data.ok ? "done — refresh run list" : `failed: ${data.error}`);
    void loadIndex();
  }

  async function handleSaveScenario() {
    try {
      const parsed = JSON.parse(scenarioJson) as { id: string; rev: number };
      parsed.rev = (parsed.rev ?? 0) + 1;
      const res = await fetch("/api/dev/bench/scenario", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: scenarioId.replace(".json", ""), data: parsed }),
      });
      const data = await res.json();
      setStatus(data.ok ? `saved rev ${parsed.rev}` : `save failed`);
      setScenarioJson(JSON.stringify(parsed, null, 2));
      void loadIndex();
    } catch {
      setStatus("invalid JSON");
    }
  }

  if (disabled) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-zinc-100">
        <h1 className="text-xl font-semibold">bench gallery</h1>
        <p className="mt-4 text-sm text-zinc-400">
          Set <code className="text-zinc-200">NEXT_PUBLIC_BENCH_UI=1</code> at build
          time and rebuild the web app to enable this page.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 font-sans text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-xl font-semibold">scenario bench gallery</h1>
          <button
            type="button"
            onClick={() => void handleRerun()}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm hover:bg-emerald-600"
          >
            re-run layout sweep
          </button>
        </header>

        {status && <p className="text-sm text-amber-300">{status}</p>}

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">runs</h2>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
              {runs.map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    className={`w-full rounded px-2 py-1 text-left hover:bg-zinc-800 ${
                      selectedRun === r.name ? "bg-zinc-800" : ""
                    }`}
                    onClick={() => void loadRun(r.name)}
                  >
                    {r.name}
                    <span className="ml-2 text-xs text-zinc-500">{r.mtime.slice(0, 10)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2 lg:col-span-2">
            <h2 className="text-sm font-semibold">cell gallery</h2>
            {report && (
              <p className="text-xs text-zinc-400">
                sweep={report.sweep} • to-bill=${report.to_bill_usd} • spent=
                {report.spent_usd ?? "—"}
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {cells.map((c) => {
                const src = sourceArtifact(c);
                return (
                  <div
                    key={c.label ?? c.cell_key}
                    className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs"
                  >
                    <div className="font-medium break-all">{c.label ?? c.cell_key}</div>
                    <div className="text-zinc-400">{c.model}</div>
                    {hasImage(c) && c.cell_key ? (
                      <div className="mt-2 flex gap-1">
                        {src && (
                          <figure className="flex-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imgUrl(c.cell_key, src)}
                              alt="source"
                              className="w-full rounded border border-zinc-800"
                            />
                            <figcaption className="text-[10px] text-zinc-500">before</figcaption>
                          </figure>
                        )}
                        <figure className="flex-1">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imgUrl(c.cell_key)}
                            alt={c.label ?? "cell"}
                            className="w-full rounded border border-zinc-800"
                          />
                          {src && (
                            <figcaption className="text-[10px] text-zinc-500">after</figcaption>
                          )}
                        </figure>
                      </div>
                    ) : (
                      <div
                        className={`mt-2 inline-block rounded px-1.5 py-0.5 text-[10px] ${
                          c.status === "failed"
                            ? "bg-red-900 text-red-200"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {c.status ?? "no image"}
                        {c.est_usd != null ? ` • $${c.est_usd}` : ""}
                      </div>
                    )}
                    {c.error && (
                      <pre className="mt-1 whitespace-pre-wrap text-[10px] text-red-300">
                        {c.error}
                      </pre>
                    )}
                    {c.scores && (
                      <pre className="mt-2 overflow-x-auto text-zinc-300">
                        {JSON.stringify(c.scores, null, 0)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">diff view</h2>
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded bg-zinc-900 px-2 py-1 text-sm"
              value={diffA}
              onChange={(e) => setDiffA(e.target.value)}
            >
              <option value="">cell A</option>
              {cells.map((c) => (
                <option key={`a-${c.label}`} value={c.label ?? c.cell_key}>
                  {c.label ?? c.cell_key}
                </option>
              ))}
            </select>
            <select
              className="rounded bg-zinc-900 px-2 py-1 text-sm"
              value={diffB}
              onChange={(e) => setDiffB(e.target.value)}
            >
              <option value="">cell B</option>
              {cells.map((c) => (
                <option key={`b-${c.label}`} value={c.label ?? c.cell_key}>
                  {c.label ?? c.cell_key}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[cellA, cellB].map((cell, i) => (
              <div key={i} className="space-y-2">
                {cell && hasImage(cell) && cell.cell_key ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imgUrl(cell.cell_key)}
                    alt={cell.label ?? "cell"}
                    className="w-full rounded border border-zinc-800"
                  />
                ) : null}
                <pre className="max-h-48 overflow-auto rounded bg-zinc-900 p-3 text-xs">
                  {cell ? JSON.stringify(cell, null, 2) : `pick cell ${i === 0 ? "A" : "B"}`}
                </pre>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">scenario editor</h2>
          <div className="flex flex-wrap gap-2">
            {scenarios.map((s) => (
              <button
                key={s}
                type="button"
                className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700"
                onClick={() => void loadScenario(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <textarea
            className="h-64 w-full rounded bg-zinc-900 p-3 font-mono text-xs text-zinc-200"
            value={scenarioJson}
            onChange={(e) => setScenarioJson(e.target.value)}
            placeholder="select a scenario to edit"
          />
          <button
            type="button"
            onClick={() => void handleSaveScenario()}
            className="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600"
            disabled={!scenarioId}
          >
            save + bump rev
          </button>
        </section>
      </div>
    </main>
  );
}
