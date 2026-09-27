"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Eye, Play, RefreshCw, Sparkles, X } from "lucide-react";
import type { PlaceBuildFloorTarget, PlaceSceneSnapshot, WorldEditProposal } from "@openflipbook/config";
import type { PlaceBuildJob } from "@/lib/place-build";
import s from "./world-editor.module.css";
import type { AssetCapabilities } from "./build-assets";
import BuildAppearance from "./build-appearance";

export default function PlaceBuilder({ scene, disabled, reviewingBuildId, onPreview, onBusy, targetFloor, onTargetFloorChange }: {
  scene: PlaceSceneSnapshot; disabled: boolean; onPreview: (p: WorldEditProposal, target?: PlaceBuildFloorTarget) => void; onBusy: (value: boolean) => void;
  reviewingBuildId?: string | undefined;
  targetFloor?: PlaceBuildFloorTarget | undefined;
  onTargetFloorChange?: (target: PlaceBuildFloorTarget | undefined) => void;
}) {
  const [prompt, setPrompt] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const [jobs, setJobs] = useState<PlaceBuildJob[]>([]), [busy, setBusy] = useState(false);
  const [materialConfig, setMaterialConfig] = useState<AssetCapabilities | null>(null), [meshConfig, setMeshConfig] = useState<AssetCapabilities | null>(null);
  const [config, setConfig] = useState<{ enabled: boolean; model?: string; reservation?: number; reason?: string; floor_target_version?: number } | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const floorTargets = scene.definition.objects.flatMap(building => (building.structure?.floors ?? []).map(floor => ({ building_id: building.id, floor_id: floor.id, label: `${building.label} / ${floor.label}` })));
  const scope = pending.current ? pending.current.target_floor as PlaceBuildFloorTarget | undefined : targetFloor;
  const scopeUnavailable = !!scope && config?.floor_target_version !== 1;
  const targetLabel = (target: PlaceBuildFloorTarget) => floorTargets.find(f => f.building_id === target.building_id && f.floor_id === target.floor_id)?.label ?? `Saved floor ${target.floor_id}`;
  useEffect(() => { if (!pending.current) setConfirmed(false); }, [targetFloor?.building_id, targetFloor?.floor_id]);
  const endpoint = `/api/world/${encodeURIComponent(scene.session_id)}/places/${encodeURIComponent(scene.place_id)}/build`;
  const call = useCallback(async (body?: unknown) => {
    const res = await fetch(endpoint, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error || "Layout generation unavailable"), { status: res.status }); return data;
  }, [endpoint]);
  const merge = (job: PlaceBuildJob) => setJobs(old => [job, ...old.filter(j => j.id !== job.id)].slice(0, 30));
  const refresh = useCallback(async () => {
    const data = await call(); setJobs(data.jobs); setConfig(data.capabilities); setMaterialConfig(data.material_capabilities ?? null); setMeshConfig(data.mesh_capabilities ?? null);
  }, [call]);
  useEffect(() => {
    let stopped = false;
    void call().then(data => { if (!stopped) { setJobs(data.jobs); setConfig(data.capabilities); setMaterialConfig(data.material_capabilities ?? null); setMeshConfig(data.mesh_capabilities ?? null); } }).catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [call]);
  const planning = jobs.some(j => ["scheduled", "planning", "validating"].includes(j.status) || [j.material_stage, j.mesh_stage].some(stage => stage?.status !== "cancelled" && stage?.items.some(i => ["scheduled", "submitting", "queued", "running", "storing"].includes(i.job.status))));
  useEffect(() => {
    if (!planning) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const data = await call(); if (!stopped) { setJobs(data.jobs); setConfig(data.capabilities); setMaterialConfig(data.material_capabilities ?? null); setMeshConfig(data.mesh_capabilities ?? null); } }
      catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [planning, call]);
  async function run(id: string) {
    setJobs(old => old.map(j => j.id === id && j.status === "queued" ? { ...j, status: "scheduled" } : j));
    try { merge((await call({ action: "run", id })).job); }
    catch (e) { setError(`${(e as Error).message}. Refresh saved status before retrying.`); }
  }
  async function generate() {
    if (disabled || busy || !config?.enabled || !confirmed || scopeUnavailable) return;
    pending.current ??= { action: "queue", id: crypto.randomUUID(), prompt, confirmed, model: config.model, reservation: config.reservation, base_revision: scene.revision, ...(targetFloor ? { target_floor: targetFloor } : {}) };
    setBusy(true); setError("");
    try {
      const { job } = await call(pending.current); merge(job); pending.current = null; setConfirmed(false);
      // The second request only schedules work; the independent worker owns execution.
      void run(job.id);
    } catch (e) {
      if ([400, 403, 404, 409, 413, 429].includes((e as Error & { status?: number }).status ?? 0)) pending.current = null;
      setError((e as Error).message);
    }
    finally { setBusy(false); }
  }
  async function preview(id: string, layoutOnly = false) {
    setBusy(true); onBusy(true); setError("");
    try { onPreview((await call({ action: "preview", id, ...(layoutOnly ? { layout_only: true } : {}) })).proposal, jobs.find(j => j.id === id)?.target_floor); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className={s.meshGenerator} aria-label="AI place layout">
    <div className={s.sectionHeading}><h2><Building2 size={16} />Generate place layout</h2><button title="Refresh layout jobs" aria-label="Refresh layout jobs" onClick={() => void refresh().catch(e => setError(e.message))}><RefreshCw size={16} /></button></div>
    {onTargetFloorChange && <label>Generation scope<select aria-label="Generation scope" value={scope?.floor_id ?? ""} disabled={busy || !!pending.current} onChange={e => {
      const floor = floorTargets.find(f => f.floor_id === e.target.value);
      onTargetFloorChange(floor ? { building_id: floor.building_id, floor_id: floor.floor_id } : undefined);
    }}><option value="">Entire place</option>{floorTargets.map(f => <option key={f.floor_id} value={f.floor_id}>{f.label}</option>)}</select></label>}
    {scopeUnavailable && <p role="status">Floor generation requires updated backend and layout workers.</p>}
    <label>Place description<textarea aria-label="Place description" maxLength={4000} value={prompt} disabled={busy || !!pending.current} onChange={e => setPrompt(e.target.value)} placeholder="A canal-side market, eight distinct workshops, a two-storey inn and a public courtyard" /></label>
    {config?.enabled && typeof config.reservation === "number" ? <>
      <div className={s.meshMeta}>{config.model} / architecture layout</div>
      <label className={s.checkbox}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />Reserve ${config.reservation.toFixed(2)} for this layout</label>
    </> : <p role="status">{config?.reason || "Checking layout generation availability..."}</p>}
    <button onClick={() => void generate()} disabled={disabled || busy || planning || !config?.enabled || !confirmed || scopeUnavailable || prompt.trim().length < 3}><Sparkles size={16} />{pending.current ? "Retry saved request" : "Generate layout"}</button>
    {error && <p role="alert">{error}</p>}
    <ul className={`${s.meshJobs} ${s.buildJobs}`}>{jobs.map(job => <li key={job.id}>
      <strong>{job.prompt}</strong><span>{job.status.replaceAll("_", " ")}{job.object_count !== undefined ? ` / ${job.object_count} additions` : ""}</span>
      {job.target_floor && <span>{targetLabel(job.target_floor)}</span>}
      {job.base_revision !== scene.revision && <span>Based on revision {job.base_revision}; current revision is {scene.revision}</span>}
      {job.stale_connections && <span>Saved connections changed; a new layout request is required.</span>}
      {job.error && <p>{job.error}</p>}
      {job.status === "invalid" && <button disabled={disabled || busy || job.stale_connections || job.base_revision !== scene.revision} onClick={() => {
        setBusy(true); setError(""); void call({ action: "revalidate", id: job.id }).then(data => merge(data.job)).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}><RefreshCw size={16} />Revalidate saved response</button>}
      {job.status === "queued" && <button title="Start reserved layout job" aria-label="Start reserved layout job" disabled={disabled || busy || job.stale_connections || job.base_revision !== scene.revision} onClick={() => void run(job.id)}><Play size={16} /></button>}
      {job.status === "ready" && <>
        {(!!job.material_plan?.length || !!job.mesh_plan?.length) && <BuildAppearance job={job} materialConfig={materialConfig} meshConfig={meshConfig} disabled={busy || disabled && reviewingBuildId !== job.id} stale={!!job.stale_connections || job.base_revision !== scene.revision} call={call} refresh={refresh} preview={layoutOnly => void preview(job.id, layoutOnly)} onBusy={setBusy}/>}
        {!job.material_plan?.length && !job.mesh_plan?.length && <button disabled={disabled || busy || job.stale_connections || job.base_revision !== scene.revision} onClick={() => void preview(job.id)}><Eye size={16} />Preview generated layout</button>}
      </>}
      {["queued", "scheduled", "planning", "validating", "submission_unknown"].includes(job.status) && <button title={["queued", "scheduled"].includes(job.status) ? "Cancel queued layout" : "Discard pending result (may still be billable)"} aria-label="Cancel layout job" onClick={() => void call({ action: "cancel", id: job.id }).then(data => merge(data.job)).catch(e => setError(e.message))}><X size={16} /></button>}
    </li>)}</ul>
  </section>;
}
