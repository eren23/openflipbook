"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, Sparkles, X } from "lucide-react";
import type { WorldEditProposal } from "@openflipbook/config";
import type { SceneEditJob } from "@/lib/scene-text-edit-server";
import s from "./world-editor.module.css";

interface Capabilities { enabled: boolean; model?: string; reservation?: number; reason?: string }
export default function PlaceSceneEdits({ sessionId, placeId, baseRevision, selectedObjectId, selectedObjectLabel, disabled, onProposal, onPendingChange }: {
  sessionId: string; placeId: string; baseRevision: number; selectedObjectId: string | null; selectedObjectLabel?: string; disabled: boolean;
  onProposal: (proposal: WorldEditProposal) => void; onPendingChange?: (value: boolean) => void;
}) {
  const [prompt, setPrompt] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const [jobs, setJobs] = useState<SceneEditJob[]>([]), [config, setConfig] = useState<Capabilities | null>(null), [busy, setBusy] = useState(false);
  const pending = useRef<{ endpoint: string; body: Record<string, unknown> } | null>(null);
  const pendingReview = useRef<{ id: string; endpoint: string; body: Record<string, unknown> } | null>(null);
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(placeId)}/text-edits`;
  const call = useCallback(async (body?: unknown, destination = endpoint) => {
    const response = await fetch(destination, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || "Scene edit unavailable"), { status: response.status }); return data;
  }, [endpoint]);
  const merge = (job: SceneEditJob) => setJobs(old => [job, ...old.filter(j => j.id !== job.id)].slice(0, 30));
  const refresh = useCallback(async () => { const data = await call(); setJobs(data.jobs); setConfig(data.capabilities); }, [call]);
  useEffect(() => { let stopped = false;
    void call().then(data => { if (!stopped) { setJobs(data.jobs); setConfig(data.capabilities); } }).catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [call]);
  useEffect(() => { if (!pending.current) setConfirmed(false); }, [baseRevision, selectedObjectId]);
  useEffect(() => { if (!pending.current) setConfirmed(false); }, [config?.model, config?.reservation]);
  const active = jobs.some(j => ["scheduled", "planning", "validating"].includes(j.status));
  useEffect(() => {
    if (!active) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const data = await call(); if (!stopped) { setJobs(data.jobs); setConfig(data.capabilities); } }
      catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000); return () => { stopped = true; clearTimeout(timer); };
  }, [active, call]);
  async function plan() {
    if (busy || pendingReview.current || !pending.current && (disabled || active || !confirmed || !config?.enabled || prompt.trim().length < 3)) return;
    if (!pending.current) pending.current = { endpoint, body: { action: "plan", id: crypto.randomUUID(), prompt, confirmed: true, model: config?.model, reservation: config?.reservation,
      base_revision: baseRevision, selected_object_ids: selectedObjectId ? [selectedObjectId] : [] } };
    setBusy(true); onPendingChange?.(true); setError("");
    try { const saved = pending.current; const data = await call(saved.body, saved.endpoint); if (saved.endpoint === endpoint) merge(data.job); pending.current = null; setConfirmed(false); }
    catch (e) {
      if ([400, 403, 404, 409, 413, 429].includes((e as Error & { status?: number }).status ?? 0)) { pending.current = null; setConfirmed(false); }
      setError((e as Error).message);
    } finally { setBusy(false); onPendingChange?.(!!pending.current); }
  }
  async function preview(id: string, refreshReview = false) {
    if (!pendingReview.current) pendingReview.current = { id, endpoint, body: { action: refreshReview ? "refresh-preview" : "preview", id, ...(refreshReview ? { review_id: crypto.randomUUID() } : {}) } };
    setBusy(true); onPendingChange?.(true); setError("");
    try { const saved = pendingReview.current; const data = await call(saved.body, saved.endpoint); pendingReview.current = null; if (saved.endpoint === endpoint) onProposal(data.proposal); }
    catch (e) {
      if ([400, 403, 404, 409, 413, 429].includes((e as Error & { status?: number }).status ?? 0)) pendingReview.current = null;
      setError((e as Error).message);
    }
    finally { setBusy(false); onPendingChange?.(!!pending.current || !!pendingReview.current); }
  }
  return <section className={s.meshGenerator} aria-label="Text scene edits">
    <div className={s.sectionHeading}><h2><Sparkles size={16}/>Edit saved scene</h2><button aria-label="Refresh scene edit jobs" title="Refresh scene edit jobs" onClick={() => void refresh().catch(e => setError(e.message))}><RefreshCw size={16}/></button></div>
    <p className={s.meshMeta}>{selectedObjectId ? selectedObjectLabel ? `Selected object: ${selectedObjectLabel}` : "Selected object" : "Entire saved place"}. Review the proposed geometry before applying.</p>
    <label>Scene edit description<textarea aria-label="Scene edit description" value={prompt} maxLength={4000} disabled={busy || !!pending.current || !!pendingReview.current} onChange={e => setPrompt(e.target.value)} placeholder="Move the selected workshop two metres east and paint it teal"/></label>
    {config?.enabled && typeof config.reservation === "number" ? <>
      <div className={s.meshMeta}>{config.model}</div>
      <label className={s.checkbox}><input type="checkbox" checked={confirmed} disabled={busy || !!pending.current || !!pendingReview.current} onChange={e => setConfirmed(e.target.checked)}/>Reserve ${config.reservation.toFixed(2)} for one edit proposal</label>
    </> : <p role="status">{config?.reason || "Checking scene edit availability..."}</p>}
    <button onClick={() => void plan()} disabled={busy || !!pendingReview.current || !pending.current && (disabled || active || !config?.enabled || !confirmed || prompt.trim().length < 3)}><Sparkles size={16}/>{pending.current ? "Retry saved edit request" : "Generate edit proposal"}</button>
    {pending.current && <p role="status">The request acknowledgement is unresolved. Retry uses the same saved request and reservation.</p>}
    {error && <p role="alert">{error}</p>}
    <ul className={`${s.meshJobs} ${s.buildJobs}`}>{jobs.map(job => <li key={job.id}>
      <strong>{job.prompt}</strong><span>{job.status.replaceAll("_", " ")}</span>
      {job.base_revision !== baseRevision && <span>Based on revision {job.base_revision}; current revision is {baseRevision}</span>}
      {job.error && <p>{job.error}</p>}
      {job.status === "ready" && <>
        <button disabled={busy || !!pendingReview.current && pendingReview.current.id !== job.id || !pendingReview.current && (disabled || job.base_revision !== baseRevision)} onClick={() => void preview(job.id)}><Eye size={16}/>{pendingReview.current?.id === job.id ? "Retry saved review" : "Preview saved edit"}</button>
        {!pendingReview.current && <button disabled={disabled || busy || job.base_revision !== baseRevision} onClick={() => void preview(job.id, true)}><RefreshCw size={16}/>Refresh saved edit review</button>}
      </>}
      {["scheduled", "planning", "validating", "submission_unknown"].includes(job.status) && <button aria-label="Cancel scene edit job" title={job.status === "scheduled" ? "Cancel before submission" : "Discard result; reservation retained"} disabled={busy} onClick={() => void call({ action: "cancel", id: job.id }).then(data => merge(data.job)).catch(e => setError(e.message))}><X size={16}/></button>}
    </li>)}</ul>
  </section>;
}
