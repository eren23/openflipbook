"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Footprints, RefreshCw, Video, X } from "lucide-react";
import type { pathVideoLibrary, walkVideoLibrary } from "@/lib/path-video";
import type { CapturePlaceView, ViewCapture } from "@/lib/place-view";
import { walkCheckpoints, type WalkWaypoint } from "@/lib/walk-route";
import s from "./world-editor.module.css";
type Library = Awaited<ReturnType<typeof pathVideoLibrary>> | Awaited<ReturnType<typeof walkVideoLibrary>>;
const dollars = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount);
// Keyframes at each checkpoint of the study (or at each saved view of a walk),
// H3 legs between them, joined. The server hides this panel (404) unless PATH_VIDEO_ENABLED=1.
export default function PathVideo({ sessionId, studyId, walk, disabled, children }: { sessionId: string; studyId?: string; walk?: { placeId: string; viewIds: string[] }; disabled: boolean; children?: ReactNode }) {
  const [library, setLibrary] = useState<Library | null>(null), [off, setOff] = useState(false);
  const [prompt, setPrompt] = useState(""), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), pending = useRef<string | null>(null);
  const noun = walk ? "walk video" : "path video";
  const url = walk ? `/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(walk.placeId)}/walk-videos`
    : `/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId!)}/path-videos`;
  const views = walk?.viewIds.join(",") ?? "";
  const reload = useCallback(async () => {
    const response = await fetch(views ? `${url}?views=${encodeURIComponent(views)}` : url, { cache: "no-store" });
    if (response.status === 404) { if (mounted.current) setOff(true); return; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Path videos unavailable");
    if (mounted.current) setLibrary(data);
  }, [url, views]);
  const refresh = useCallback(() => void reload().catch(e => { if (mounted.current) setError(e.message); }), [reload]);
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
  // Only a first paint reads words; chain keyframes copy the accepted artwork.
  const appearance = !!library?.quote?.appearance;
  const sha = library && ("views_sha256" in library ? library.views_sha256 : library.study_sha256);
  const active = library?.jobs.some(job => job.status === "scheduled" || job.status === "running");
  useEffect(() => { if (!active) return; const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [active, refresh]);
  useEffect(() => { setConsent(false); }, [library?.quote?.reservation, sha]);
  async function send(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      // A lost generate response is retried with the same id, so it cannot reserve twice.
      const payload = body.action === "generate" ? pending.current ??= JSON.stringify({ action: "generate", id: crypto.randomUUID(), confirmed: true,
        prompt, ...(walk ? { view_ids: walk.viewIds, views_sha256: sha } : { study_sha256: sha }), reservation: library!.quote!.reservation }) : JSON.stringify(body);
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
  return <section aria-label={walk ? "Walk video" : "Path video"} className={s.illustrationGenerator}>
    <div className={s.sectionHeading}><h3>{walk ? "Walk video" : "Path video"}</h3>
      <button title="Refresh path videos" aria-label="Refresh path videos" disabled={busy} onClick={refresh}><RefreshCw size={16}/></button></div>
    {children}
    {library && (!walk || library.checkpoints > 0) && <p role="status">{library.checkpoints} keyframe checkpoints / {Math.max(0, library.checkpoints - 1)} legs</p>}
    {library?.quote && <>
      {appearance && <label>Appearance<textarea aria-label="Path video appearance" value={prompt} maxLength={1024} disabled={busy || disabled} onChange={e => setPrompt(e.target.value)}/></label>}
      <label className={s.checkbox}><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={e => setConsent(e.target.checked)}/>
        Reserve {dollars(library.quote.reservation)} for {library.quote.paid_keyframes} keyframes and {library.quote.legs.length} legs</label>
    </>}
    {(library?.quote || pending.current) && <button disabled={busy || !pending.current && (disabled || !consent || appearance && prompt.trim().length < 3)} onClick={() => void send({ action: "generate" })}>
      <Video size={16}/>{busy ? "Submitting..." : pending.current ? `Retry same ${noun} request` : `Generate ${noun}`}</button>}
    {library?.reason && <p>{library.reason}</p>}
    {library?.jobs.map(job => <div key={job.id} className={s.illustrationJob}>
      <span>{job.status.replaceAll("_", " ")} / {dollars(job.committed)} of {dollars(job.reservation)} committed</span>
      {job.error && <p>{job.error}</p>}
      <ol>{job.keyframes.map((kf, i) => <li key={i}>Keyframe {i + 1}: {kf.stage === "source" ? "accepted artwork" : kf.status.replaceAll("_", " ")}{kf.gate ? ` / gate ${kf.gate}` : ""}
        {kf.retry === "reserved" && " / painted twice"}{kf.dropped && <strong> / dropped: {kf.drop_reason}</strong>}{kf.kept_reason && <strong> / {kf.kept_reason}</strong>}</li>)}</ol>
      <ol>{job.legs.map((leg, i) => <li key={i}>Leg {i + 1}: {leg.seconds}s ({leg.duration}s clip)
        {leg.attempts.map((a, n) => <span key={n}> / {a.status.replaceAll("_", " ")}{a.land === undefined ? "" : ` land ${a.land.toFixed(2)} snap ${a.snap!.toFixed(1)}`}</span>)}
        {leg.landed === false && <strong> / did not land</strong>}{leg.dropped && <strong> / dropped</strong>}</li>)}</ol>
      {(job.status === "scheduled" || job.status === "running" || job.status === "submission_unknown") &&
        <button title="Cancel path video" aria-label="Cancel path video" disabled={busy} onClick={() => void send({ action: "cancel", id: job.id })}><X size={16}/></button>}
      {job.media && <video controls playsInline muted preload="metadata" style={{ width: "100%", aspectRatio: `${job.media.width}/${job.media.height}` }}
        src={`${url}/${encodeURIComponent(job.id)}/video`} onError={() => setError("Saved path video unavailable")}/>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}

// "Make walk video" for a route walked in 3D: a free saved view at each
// eye-level checkpoint (walk-route walkCheckpoints), then the priced panel
// above for one video over those views, in order.
export function WalkVideo({ sessionId, placeId, route, capture, disabled }: { sessionId: string; placeId: string; route: readonly WalkWaypoint[]; capture: CapturePlaceView | null; disabled: boolean }) {
  const [viewIds, setViewIds] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<{ id: string; label: string; capture: ViewCapture; walk_checkpoint: true }[] | null>(null);
  async function make() {
    setBusy(true); setError("");
    try {
      // A retry resends the same ids and captures, so a lost response saves nothing twice.
      const requests = pending.current ??= walkCheckpoints(route).map((pose, i, all) => ({ id: crypto.randomUUID(), label: `Walk checkpoint ${i + 1}/${all.length}`, capture: capture!(pose), walk_checkpoint: true as const }));
      const ids: string[] = [];
      for (const body of requests) {
        const response = await fetch(`/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(placeId)}/views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) { if (response.status < 500) pending.current = null; throw new Error(data.error || "Walk checkpoint could not be saved"); }
        // The server reuses a current checkpoint saved at the same camera.
        ids.push(data.id);
      }
      pending.current = null; setViewIds(ids);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <PathVideo sessionId={sessionId} walk={{ placeId, viewIds }} disabled={disabled}>
    {!viewIds.length && <button disabled={busy || disabled || !capture} title="Save a camera view at each checkpoint of this walk (free), then price one video" onClick={() => void make()}>
      <Footprints size={16}/>{busy ? "Saving walk checkpoints..." : pending.current ? "Retry walk checkpoints" : "Make walk video"}</button>}
    {error && <p role="alert">{error}</p>}
  </PathVideo>;
}
