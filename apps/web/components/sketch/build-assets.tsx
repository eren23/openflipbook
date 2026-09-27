"use client";
import { useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, Sparkles, X } from "lucide-react";
import type { PlaceBuildJob } from "@/lib/place-build";
import type { AssetQuote } from "@/lib/asset-reservation";
import type { AssetKind } from "@/lib/asset-pipeline";
import { reservationLabel } from "@/lib/reservation-label";
import s from "./world-editor.module.css";

export type AssetCapabilities = Partial<AssetQuote> & { enabled: boolean; reason?: string };
export default function BuildAssets({ job, config, disabled, stale, call, refresh, preview, kind = "material", managed = false }: {
  job: PlaceBuildJob; config: AssetCapabilities | null; disabled: boolean; stale: boolean; kind?: AssetKind;
  call: (body: unknown) => Promise<unknown>; refresh: () => Promise<void>; preview: (layoutOnly: boolean) => void;
  managed?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false), [replacement, setReplacement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<Record<string, unknown> | null>(null);
  const plan = (kind === "mesh" ? job.mesh_plan : job.material_plan) ?? [], stage = kind === "mesh" ? job.mesh_stage : job.material_stage;
  const plural = kind === "mesh" ? "meshes" : "materials", title = kind === "mesh" ? "Meshes" : "Materials";
  const cost = config?.reservation ?? 0;
  const quoteKey = JSON.stringify([config?.model, config?.reservation, config?.parameters]);
  useEffect(() => { setConfirmed(false); setReplacement(null); }, [quoteKey]);
  async function action(body: Record<string, unknown>, paid = false) {
    if (busy || disabled) return;
    if (paid) pending.current ??= { ...body, id: job.id, request_id: crypto.randomUUID(), confirmed: true, model: config?.model, reservation: cost, parameters: config?.parameters };
    setBusy(true); setError("");
    try {
      await call(paid ? pending.current : { ...body, id: job.id });
      if (paid) { pending.current = null; setConfirmed(false); setReplacement(null); }
      await refresh();
    } catch (e) {
      if ([400, 403, 404, 409, 413, 429].includes((e as Error & { status?: number }).status ?? 0)) pending.current = null;
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  if (!plan.length) return null;
  const locked = disabled || busy || !!pending.current;
  return <div role="group" aria-label={`Build ${plural}`}>
    <strong>{title}{stage ? ` / ${stage.status}` : ` / ${plan.length} proposed`}</strong>
    <ul className={s.meshJobs}>{plan.map(p => {
      const child = stage?.items.find(i => i.plan_id === p.id)?.job;
      return <li key={p.id}>
        <span>{p.prompt}</span><span className={s.meshMeta}>{"role" in p ? `${p.targets.length} placements / ${p.role === "exterior" ? "solid exterior, no interior" : "prop"}` : `${p.targets.length} surfaces / ${[...new Set(p.targets.map(t => t.object_id === null ? "ground" : t.surface))].join(", ")}`}</span>
        {child && <>
          <span>{child.status.replaceAll("_", " ")}</span>{child.error && <p>{child.error}</p>}
          {["queued", "running", "storage_failed", "submission_unknown"].includes(child.status) && <button disabled={locked || stage?.status === "cancelled"} title={`Refresh saved ${kind} / retry storage`} aria-label={`Refresh ${kind} ${p.id}`} onClick={() => void action({ action: `refresh-${kind}`, job_id: child.id })}><RefreshCw size={16}/></button>}
          {!["ready", "failed", "cancelled"].includes(child.status) && <button disabled={locked || stage?.status === "cancelled"} title={`Discard ${kind} result (may still be billable)`} aria-label={`Discard ${kind} ${p.id}`} onClick={() => void action({ action: `discard-${kind}`, job_id: child.id })}><X size={16}/></button>}
          {["failed", "cancelled"].includes(child.status) && stage?.status !== "cancelled" && config?.enabled && <>
            <label className={s.checkbox}><input type="checkbox" checked={replacement === p.id} disabled={locked || stale} onChange={e => setReplacement(e.target.checked ? p.id : null)}/>Reserve ${reservationLabel(cost)} for replacement</label>
            <button disabled={locked || stale || replacement !== p.id} onClick={() => void action({ action: `replace-${kind}`, plan_id: p.id }, true)}><Sparkles size={16}/>Replace failed {kind}</button>
          </>}
        </>}
      </li>;
    })}</ul>
    {!managed && !stage && (config?.enabled ? <>
      <label className={s.checkbox}><input type="checkbox" checked={confirmed} disabled={locked || stale} onChange={e => setConfirmed(e.target.checked)}/>Reserve ${(cost * plan.length).toFixed(2)} for {plan.length} {plan.length === 1 ? kind : plural}</label>
      <button disabled={locked || stale || !confirmed} onClick={() => void action({ action: plural }, true)}><Sparkles size={16}/>Generate build {plural}</button>
    </> : <p role="status">{config?.reason || `Checking ${kind} availability...`}</p>)}
    {pending.current && <button disabled={disabled || busy} onClick={() => void action(pending.current!, true)}><RefreshCw size={16}/>Retry saved {kind} request</button>}
    {!managed && stage?.status === "ready" && <button disabled={locked || stale} onClick={() => preview(false)}><Eye size={16}/>{kind === "mesh" ? "Preview generated meshes" : "Preview textured layout"}</button>}
    {stage && stage.status !== "cancelled" && stage.status !== "ready" && <button disabled={locked} title={`Cancel remaining ${plural} (submitted work may be billable)`} aria-label={`Cancel build ${plural}`} onClick={() => void action({ action: `cancel-${plural}` })}><X size={16}/></button>}
    {!managed && <button disabled={locked || stale} onClick={() => preview(true)}><Eye size={16}/>Preview layout only</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
