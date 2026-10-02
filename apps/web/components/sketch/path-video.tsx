"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Video, X } from "lucide-react";
import type { pathVideoLibrary } from "@/lib/path-video";
import s from "./world-editor.module.css";
type Library = Awaited<ReturnType<typeof pathVideoLibrary>>;
const dollars = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount);
// Keyframes at each checkpoint of the study, H3 legs between them, joined.
// The server hides this panel (404) unless PATH_VIDEO_ENABLED=1.
export default function PathVideo({ sessionId, studyId, disabled }: { sessionId: string; studyId: string; disabled: boolean }) {
  const [library, setLibrary] = useState<Library | null>(null), [off, setOff] = useState(false);
  const [prompt, setPrompt] = useState(""), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), pending = useRef<string | null>(null);
  const url = `/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId)}/path-videos`;
  const reload = useCallback(async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) { if (mounted.current) setOff(true); return; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Path videos unavailable");
    if (mounted.current) setLibrary(data);
  }, [url]);
  const refresh = useCallback(() => void reload().catch(e => { if (mounted.current) setError(e.message); }), [reload]);
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
  // Only a first paint reads words; chain keyframes copy the accepted artwork.
  const appearance = !!library?.quote?.appearance;
  const active = library?.jobs.some(job => job.status === "scheduled" || job.status === "running");
  useEffect(() => { if (!active) return; const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [active, refresh]);
  useEffect(() => { setConsent(false); }, [library?.quote?.reservation, library?.study_sha256]);
  async function send(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      // A lost generate response is retried with the same id, so it cannot reserve twice.
      const payload = body.action === "generate" ? pending.current ??= JSON.stringify({ action: "generate", id: crypto.randomUUID(), confirmed: true,
        prompt, study_sha256: library!.study_sha256, reservation: library!.quote!.reservation }) : JSON.stringify(body);
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), result = await response.json();
      if (!response.ok) {
        if (body.action === "generate" && response.status < 500) pending.current = null;
        throw new Error(result.error || "Path video request failed");
      }
      if (body.action === "generate") { pending.current = null; setConsent(false); }
      await reload();
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (off) return null;
  return <section aria-label="Path video" className={s.illustrationGenerator}>
    <div className={s.sectionHeading}><h3>Path video</h3>
      <button title="Refresh path videos" aria-label="Refresh path videos" disabled={busy} onClick={refresh}><RefreshCw size={16}/></button></div>
    {library && <p role="status">{library.checkpoints} keyframe checkpoints / {Math.max(0, library.checkpoints - 1)} legs</p>}
    {library?.quote && <>
      {appearance && <label>Appearance<textarea aria-label="Path video appearance" value={prompt} maxLength={1024} disabled={busy || disabled} onChange={e => setPrompt(e.target.value)}/></label>}
      <label className={s.checkbox}><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={e => setConsent(e.target.checked)}/>
        Reserve {dollars(library.quote.reservation)} for {library.quote.paid_keyframes} keyframes and {library.quote.legs.length} legs</label>
    </>}
    {(library?.quote || pending.current) && <button disabled={busy || !pending.current && (disabled || !consent || appearance && prompt.trim().length < 3)} onClick={() => void send({ action: "generate" })}>
      <Video size={16}/>{busy ? "Submitting..." : pending.current ? "Retry same path video request" : "Generate path video"}</button>}
    {library?.reason && <p>{library.reason}</p>}
    {library?.jobs.map(job => <div key={job.id} className={s.illustrationJob}>
      <span>{job.status.replaceAll("_", " ")} / {dollars(job.committed)} of {dollars(job.reservation)} committed</span>
      {job.error && <p>{job.error}</p>}
      <ol>{job.keyframes.map((kf, i) => <li key={i}>Keyframe {i + 1}: {kf.stage === "source" ? "accepted artwork" : kf.status.replaceAll("_", " ")}{kf.gate ? ` / gate ${kf.gate}` : ""}</li>)}</ol>
      <ol>{job.legs.map((leg, i) => <li key={i}>Leg {i + 1}: {leg.seconds}s ({leg.duration}s clip)
        {leg.attempts.map((a, n) => <span key={n}> / {a.status.replaceAll("_", " ")}{a.land === undefined ? "" : ` land ${a.land.toFixed(2)} snap ${a.snap!.toFixed(1)}`}</span>)}
        {leg.landed === false && <strong> / did not land</strong>}</li>)}</ol>
      {(job.status === "scheduled" || job.status === "running" || job.status === "submission_unknown") &&
        <button title="Cancel path video" aria-label="Cancel path video" disabled={busy} onClick={() => void send({ action: "cancel", id: job.id })}><X size={16}/></button>}
      {job.media && <video controls playsInline muted preload="metadata" style={{ width: "100%", aspectRatio: `${job.media.width}/${job.media.height}` }}
        src={`${url}/${encodeURIComponent(job.id)}/video`} onError={() => setError("Saved path video unavailable")}/>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
