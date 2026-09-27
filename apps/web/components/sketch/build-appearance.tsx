"use client";
import { useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, Sparkles } from "lucide-react";
import type { PlaceBuildJob } from "@/lib/place-build";
import { reservationLabel } from "@/lib/reservation-label";
import BuildAssets, { type AssetCapabilities } from "./build-assets";
import s from "./world-editor.module.css";

export default function BuildAppearance({ job, materialConfig, meshConfig, disabled, stale, call, refresh, preview, onBusy }: {
  job: PlaceBuildJob; materialConfig: AssetCapabilities | null; meshConfig: AssetCapabilities | null; disabled: boolean; stale: boolean;
  call: (body: unknown) => Promise<unknown>; refresh: () => Promise<void>; preview: (layoutOnly: boolean) => void; onBusy: (busy: boolean) => void;
}) {
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<Record<string, unknown> | null>(null);
  const entries = [
    { kind: "material" as const, count: job.material_plan?.length ?? 0, config: materialConfig, stage: job.material_stage },
    { kind: "mesh" as const, count: job.mesh_plan?.length ?? 0, config: meshConfig, stage: job.mesh_stage },
  ].filter(e => e.count > 0);
  const remaining = entries.filter(e => !e.stage);
  const usable = (config: AssetCapabilities | null) => !!config?.enabled && typeof config.model === "string" && typeof config.reservation === "number" && Number.isFinite(config.reservation) && config.reservation > 0 && config.reservation <= 10 && !!config.parameters && typeof config.parameters === "object" && !Array.isArray(config.parameters);
  const available = remaining.length > 0 && remaining.every(e => usable(e.config));
  const total = remaining.reduce((sum, e) => sum + (e.config?.reservation ?? 0) * e.count, 0);
  const quotes = Object.fromEntries(remaining.map(e => [e.kind, { model: e.config?.model, reservation: e.config?.reservation, parameters: e.config?.parameters }]));
  const quoteKey = JSON.stringify([job.id, remaining.map(e => [e.kind, e.count]), quotes, stale, disabled]);
  useEffect(() => { setConfirmed(false); }, [quoteKey]);
  const missingApproval = !!job.appearance_approval && entries.some(e => !e.stage);
  const ready = entries.every(e => e.stage?.status === "ready");
  const count = entries.reduce((sum, e) => sum + e.count, 0), completed = entries.reduce((sum, e) => sum + (e.stage?.items.filter(i => i.job.status === "ready").length ?? 0), 0);
  const summary = remaining.map(e => `${e.count} ${e.count === 1 ? e.kind : e.kind === "mesh" ? "meshes" : "materials"}`).join(" and ");
  async function generate() {
    if (busy || !pending.current && (disabled || stale || missingApproval || !available || !confirmed)) return;
    pending.current ??= { action: "appearance", id: job.id, request_id: crypto.randomUUID(), confirmed: true, total_reservation: total, quotes };
    setBusy(true); onBusy(true); setError("");
    try { await call(pending.current); await refresh(); pending.current = null; setConfirmed(false); }
    catch (e) {
      if ([400,403,404,409,413,429].includes((e as Error & { status?: number }).status ?? 0)) { pending.current = null; setConfirmed(false); }
      setError((e as Error).message);
    } finally { setBusy(false); onBusy(false); }
  }
  if (!entries.length) return null;
  const locked = disabled || busy || !!pending.current;
  return <div role="group" aria-label="Build appearance">
    <strong>Appearance / {completed} of {count} ready</strong>
    {missingApproval && <p role="alert">A saved appearance stage is missing. Restore its records; no new generation was scheduled.</p>}
    {!!remaining.length && !missingApproval && <>
      {available ? <label className={s.checkbox}><input type="checkbox" disabled={locked || stale} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Reserve ${reservationLabel(total)} for {summary}</label>
        : remaining.filter(e=>!usable(e.config)).map(e=><p role="status" key={e.kind}>{e.kind === "mesh" ? "Meshes" : "Materials"}: {e.config?.reason || (e.config ? "Generation configuration unavailable" : "Checking availability...")}</p>)}
      {!pending.current && <button disabled={locked || stale || !available || !confirmed} onClick={()=>void generate()}><Sparkles size={16}/>{entries.some(e=>e.stage) ? "Generate remaining appearance" : "Generate appearance"}</button>}
    </>}
    {pending.current && <button disabled={busy} onClick={()=>void generate()}><RefreshCw size={16}/>Retry saved appearance request</button>}
    {entries.map(e=><BuildAssets key={e.kind} managed kind={e.kind} job={job} config={e.config} disabled={locked} stale={stale} call={call} refresh={refresh} preview={preview}/>)}
    <button disabled={locked || stale || missingApproval || !ready} onClick={()=>preview(false)}><Eye size={16}/>Preview complete appearance</button>
    <button disabled={locked || stale} onClick={()=>preview(true)}><Eye size={16}/>Preview layout only</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
