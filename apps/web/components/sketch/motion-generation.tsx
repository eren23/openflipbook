"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw, ScanEye, Video, X } from "lucide-react";
import MotionReview from "./motion-review";
import type { motionJobLibrary } from "@/lib/motion-job-server";
import s from "./world-editor.module.css";
type Library = Awaited<ReturnType<typeof motionJobLibrary>>;
const dollars = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount);
export default function MotionGeneration({ sessionId, studyId, disabled, onTime }: {
  sessionId: string; studyId: string; disabled: boolean; onTime: (seconds: number) => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null), [selected, setSelected] = useState("");
  const [consent, setConsent] = useState(false), [experimental, setExperimental] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const mounted = useRef(true), writing = useRef(false), pending = useRef<string | null>(null), reads = useRef({ version: 0 });
  const url = `/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId)}/jobs`;
  const reload = useCallback(async () => {
    const version = ++reads.current.version, response = await fetch(url, { cache: "no-store" }), data = await response.json();
    if (!mounted.current || version !== reads.current.version) return;
    if (!response.ok) throw new Error(data.error || "Motion jobs unavailable");
    setLibrary(data); setSelected(old => data.assets.some((asset: { id: string }) => asset.id === old) ? old : data.accepted_id ?? data.assets[0]?.id ?? "");
  }, [url]);
  useEffect(() => { const state = reads.current; mounted.current = true; void reload().catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; state.version++; }; }, [reload]);
  const active = library?.jobs.some(job => ["scheduled", "submitting", "queued", "running", "storing", "submission_unknown"].includes(job.status));
  useEffect(() => { if (!active) return; const timer = setInterval(() => { void reload().catch(e => { if (mounted.current) setError(e.message); }); }, 5000); return () => clearInterval(timer); }, [active, reload]);
  useEffect(() => { setConsent(false); }, [library?.quote?.reservation, library?.study_sha256, library?.comparison?.sha256]);
  async function action(body: Record<string, unknown>) {
    if (writing.current) return false;
    if (body.action === "generate" && !pending.current && (disabled || !consent || !experimental || !library?.quote)) return false;
    writing.current = true; setBusy(true); setError(""); reads.current.version++;
    try {
      const payload = body.action === "generate" ? pending.current ??= JSON.stringify({ action: "generate", id: crypto.randomUUID(),
        confirmed: true, calibration_confirmed: true, study_sha256: library!.study_sha256, comparison_sha256: library!.comparison.sha256, reservation: library!.quote!.reservation }) : JSON.stringify(body);
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), result = await response.json();
      if (!response.ok) {
        if (body.action === "generate" && [400, 403, 404, 409, 413, 429].includes(response.status)) pending.current = null;
        throw new Error(result.error || "Motion request failed");
      }
      if (body.action === "generate") { pending.current = null; if (mounted.current) setConsent(false); }
      await reload();
      return true;
    } catch (e) { if (mounted.current) setError((e as Error).message); return false; }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  const asset = library?.assets.find(item => item.id === selected);
  const latestReview = library?.reviews?.find(item => item.asset_id === selected);
  return <section aria-label="AI camera motion" className={s.illustrationGenerator}>
    <div className={s.sectionHeading}><h3>AI camera motion</h3>
      <button title="Refresh motion jobs" aria-label="Refresh motion jobs" disabled={busy} onClick={() => void reload().catch(e => { if (mounted.current) setError(e.message); })}><RefreshCw size={16}/></button></div>
    <p role="status">H3 mapping / uncalibrated</p>
    {library?.comparison && <details><summary>Comparison criteria / {library.comparison.plan.issues.length ? "incomplete reference" : "ready"}</summary>
      <p>Position: {library.comparison.plan.tolerances.position * 100}% of image / size: {library.comparison.plan.tolerances.relative_size * 100}% / direction cosine: {library.comparison.plan.tolerances.direction_cosine}</p>
      <p>{library.comparison.plan.landmarks.map(item => item.label).join(", ")}</p>
      <p>Human measurements / architecture / occlusion order / continuous motion</p>
      {library.comparison.plan.issues.length > 0 && <ul>{library.comparison.plan.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    </details>}
    {library?.quote && <>
      <label className={s.checkbox}><input type="checkbox" checked={experimental} disabled={busy || disabled} onChange={e => setExperimental(e.target.checked)}/>Use experimental camera mapping</label>
      <label className={s.checkbox}><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={e => setConsent(e.target.checked)}/>Reserve {dollars(library.quote.reservation)} for this clip</label>
    </>}
    {(library?.quote || pending.current) && <button disabled={busy || !pending.current && (disabled || !consent || !experimental)} onClick={() => void action({ action: "generate" })}><Video size={16}/>{busy ? "Submitting..." : pending.current ? "Retry same motion request" : "Generate calibration clip"}</button>}
    {library?.reason && <p>{library.reason}</p>}
    {library?.jobs.map(job => <div key={job.id} className={s.illustrationJob}>
      <span>{job.status.replaceAll("_", " ")} / {dollars(job.reservation)} reserved</span>
      {job.error && <p>{job.error}</p>}
      {job.status === "storage_failed" && <button disabled={busy} onClick={() => void action({ action: "retry_storage", id: job.id })}><RefreshCw size={16}/>Retry storage</button>}
      {!["ready", "failed", "cancelled"].includes(job.status) && <button title="Cancel motion job" aria-label="Cancel motion job" disabled={busy} onClick={() => void action({ action: "cancel", id: job.id })}><X size={16}/></button>}
    </div>)}
    {!!library?.assets.length && <label>Saved AI clip<select aria-label="Saved AI clip" value={selected} onChange={e => setSelected(e.target.value)}>{library.assets.map((item, i) => <option key={item.id} value={item.id}>Clip {library.assets.length - i}{item.historical ? " / historical" : ""}</option>)}</select></label>}
    {asset && <>
      {asset.imported && <p>Imported clip / user-supplied evidence</p>}
      <video key={asset.id} controls playsInline muted preload="metadata" style={{ width: "100%", aspectRatio: `${asset.media.width}/${asset.media.height}` }}
        src={`/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId)}/videos/${encodeURIComponent(asset.id)}`}
        onTimeUpdate={e => onTime(e.currentTarget.currentTime)} onError={() => setError("Saved video unavailable")}/>
      {!asset.duration_matches && <p role="alert">Clip duration differs from its reference path</p>}
      {asset.comparison ? <button disabled={busy} onClick={() => setReviewing(true)}><ScanEye size={16}/>Compare with geometry</button> : <p>No pre-submission comparison contract / historical replay only</p>}
      {latestReview && <p role="status">Saved human review / {latestReview.outcome.status}</p>}
      <button disabled={busy || disabled || asset.historical || library!.accepted_id === asset.id || latestReview?.outcome.status !== "pass"} onClick={() => void action({ action: "accept", id: asset.id, previous_id: library!.accepted_id, review_id: latestReview!.id })}><Check size={16}/>{library!.accepted_id === asset.id ? "Accepted clip" : "Accept reviewed clip"}</button>
      {reviewing && asset.comparison && <MotionReview key={asset.id} sessionId={sessionId} studyId={studyId} assetId={asset.id} comparison={asset.comparison} media={asset.media}
        initial={latestReview?.review} onClose={() => setReviewing(false)} onSave={action}/>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
