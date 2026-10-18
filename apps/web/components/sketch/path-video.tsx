"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Footprints, RefreshCw, Video, X } from "lucide-react";
import Image from "next/image";
import type { pathVideoLibrary, walkVideoLibrary } from "@/lib/path-video";
import type { CapturePlaceView, ViewCapture } from "@/lib/place-view";
import { walkCheckpoints, type WalkWaypoint } from "@/lib/walk-route";
import s from "./world-editor.module.css";
import SavedWalkPlayer from "./saved-walk-player";
type Library = Awaited<ReturnType<typeof pathVideoLibrary>> | Awaited<ReturnType<typeof walkVideoLibrary>>;
type ResumeQuote = NonNullable<Library["jobs"][number]["resume_quote"]>;
type ListedJob = Library["jobs"][number];
type PendingRequest = { action: "generate" | "resume"; jobId?: string; url: string; payload: string };
const dollars = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount);
const resumeSignature = (quote: ResumeQuote) => JSON.stringify(quote);
// Keyframes at each checkpoint of the study (or at each saved view of a walk),
// H3 legs between them, joined. The server hides this panel (404) unless PATH_VIDEO_ENABLED=1.
export default function PathVideo({ sessionId, studyId, walk, disabled, children, refreshKey = 0, preferReviewed = false }: { sessionId: string; studyId?: string; walk?: { placeId: string; viewIds: string[] }; disabled: boolean; children?: ReactNode; refreshKey?: number; preferReviewed?: boolean }) {
  const [library, setLibrary] = useState<Library | null>(null), [off, setOff] = useState(false);
  const [prompt, setPrompt] = useState(""), [consentFor, setConsentFor] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [resumeConsents, setResumeConsents] = useState<Record<string, string>>({});
  const [acceptedOnly, setAcceptedOnly] = useState(preferReviewed);
  const lastPreference = useRef(preferReviewed);
  useEffect(() => { if (preferReviewed && !lastPreference.current) setAcceptedOnly(true); lastPreference.current = preferReviewed; }, [preferReviewed]);
  const mounted = useRef(true), submitting = useRef(false), pending = useRef<PendingRequest | null>(null), readVersion = useRef(0);
  const noun = walk ? "walk video" : "path video";
  const url = walk ? `/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(walk.placeId)}/walk-videos`
    : `/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId!)}/path-videos`;
  const views = walk?.viewIds.join(",") ?? "";
  const policy = acceptedOnly && walk && walk.viewIds.length >= 2 ? walk.viewIds.length === 2 ? "accepted-only-v1" : "accepted-route-v1" : undefined;
  const readUrl = views ? `${url}?views=${encodeURIComponent(views)}${policy ? `&keyframe_policy=${policy}` : ""}` : url;
  const scope = readUrl, currentScope = useRef(scope);
  currentScope.current = scope;
  const reload = useCallback(async () => {
    if (currentScope.current !== scope) return;
    const version = ++readVersion.current;
    try {
      const response = await fetch(readUrl, { cache: "no-store" });
      if (!mounted.current || currentScope.current !== scope || version !== readVersion.current) return;
      if (response.status === 404) { setOff(true); return; }
      const data = await response.json();
      if (!mounted.current || currentScope.current !== scope || version !== readVersion.current) return;
      if (!response.ok) throw new Error(data.error || "Path videos unavailable");
      setLibrary(data); setOff(false); setError("");
    } catch (e) {
      if (mounted.current && currentScope.current === scope && version === readVersion.current) setError((e as Error).message);
    }
  }, [readUrl, scope]);
  const refresh = useCallback(() => void reload(), [reload]);
  const lastExternalRefresh = useRef(refreshKey);
  useEffect(() => {
    if (lastExternalRefresh.current === refreshKey) return;
    lastExternalRefresh.current = refreshKey;
    setLibrary(null); setConsentFor(""); setResumeConsents({}); refresh();
  }, [refreshKey, refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (pending.current?.url !== url) pending.current = null;
    setLibrary(null); setOff(false); setConsentFor(""); setResumeConsents({}); setError(""); refresh();
  }, [refresh, url]);
  // Only a first paint reads words; chain keyframes copy the accepted artwork.
  const appearance = !!library?.quote?.appearance;
  const sha = library && ("views_sha256" in library ? library.views_sha256 : library.study_sha256);
  const anchorSha = library?.accepted_anchors_sha256;
  const active = library?.jobs.some(job => job.status === "scheduled" || job.status === "running");
  useEffect(() => { if (!active) return; const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [active, refresh]);
  // Consent is for one exact quote, so a new quote is not approved in the same render.
  // An effect that cleared consent after the render could undo a click on the new quote.
  const quoteKey = library?.quote ? JSON.stringify([library.quote, sha, anchorSha]) : "", consent = !!quoteKey && consentFor === quoteKey;
  async function send(body: Record<string, unknown>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      // A lost acknowledgement retries the exact approved request and id.
      if (body.action === "generate" && !pending.current) pending.current = { action: "generate", url, payload: JSON.stringify({ action: "generate", id: crypto.randomUUID(), confirmed: true,
        prompt, ...(walk ? { view_ids: walk.viewIds, views_sha256: sha, ...(policy ? { keyframe_policy: policy, accepted_anchors_sha256: anchorSha } : {}) } : { study_sha256: sha }), reservation: library!.quote!.reservation }) };
      if (body.action === "resume" && !pending.current) pending.current = { action: "resume", url, jobId: body.id as string, payload: JSON.stringify({ ...body, request_id: crypto.randomUUID() }) };
      const paid = body.action === "generate" || body.action === "resume";
      const payload = paid ? pending.current!.payload : JSON.stringify(body);
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), result = await response.json();
      if (!response.ok) {
        if (paid && response.status < 500) pending.current = null;
        throw new Error(result.error || "Path video request failed");
      }
      if (paid) { pending.current = null; if (mounted.current && currentScope.current === scope) { setConsentFor(""); setResumeConsents({}); } }
      await reload();
    } catch (e) { if (mounted.current && currentScope.current === scope) setError((e as Error).message); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  if (off) return null;
  return <section aria-label={walk ? "Walk video" : "Path video"} className={s.illustrationGenerator}>
    <div className={s.sectionHeading}><h3>{walk ? "Walk video" : "Path video"}</h3>
      <button title="Refresh path videos" aria-label="Refresh path videos" disabled={busy} onClick={refresh}><RefreshCw size={16}/></button></div>
    {children}
    {walk && walk.viewIds.length >= 2 && <label className={s.checkbox}><input type="checkbox" checked={acceptedOnly} disabled={busy || disabled || !!pending.current} onChange={event => setAcceptedOnly(event.target.checked)}/>
      {walk.viewIds.length === 2 ? "Use only the two accepted artworks (no new images)" : "Use only the reviewed route artworks (no new images)"}</label>}
    {library && (!walk || library.checkpoints > 0) && <p role="status">{library.checkpoints} keyframe checkpoints / {Math.max(0, library.checkpoints - 1)} legs</p>}
    {library?.quote && <>
      {appearance && <label>Appearance<textarea aria-label="Path video appearance" value={prompt} maxLength={1024} disabled={busy || disabled} onChange={e => setPrompt(e.target.value)}/></label>}
      <label className={s.checkbox}><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={e => setConsentFor(e.target.checked ? quoteKey : "")}/>
        Approve up to {dollars(library.quote.reservation)} (expected {dollars(library.quote.expected_cost ?? library.quote.reservation)}) for {library.quote.paid_keyframes} keyframes and {library.quote.legs.length} legs</label>
      {library.quote.retry_allowance === 1 && <p>Includes up to one consistency retry per paid step. A failed retry pauses for review and a new quote.</p>}
      {policy && <p>{policy === "accepted-only-v1" ? "One five-second leg from the exact reviewed JPEG anchors." : "One five-second leg for each adjacent reviewed pair."} No artwork generation or paid retry. A failed check preserves the clip for review.</p>}
    </>}
    {(library?.quote || pending.current?.action === "generate") && <button disabled={busy || pending.current?.action === "resume" || !pending.current && (disabled || !consent || appearance && prompt.trim().length < 3)} onClick={() => void send({ action: "generate" })}>
      <Video size={16}/>{busy ? "Submitting..." : pending.current?.action === "generate" ? `Retry same ${noun} request` : `Generate ${noun}`}</button>}
    {library?.reason && <p>{library.reason}</p>}
    {library?.jobs.map((job: ListedJob) => <div key={job.id} className={s.illustrationJob}>
      <span>{job.status === "ready" ? "ready for review" : job.status === "needs_review" ? "paused for review" : job.status.replaceAll("_", " ")} / {dollars(job.committed)} of {dollars(job.reservation)} committed</span>
      {job.archive_provenance && <p>Archived {job.archive_provenance.original_status.replaceAll("_", " ")} work from {job.archive_provenance.source_session_id}; {dollars(job.archive_provenance.committed)} previously committed. Playback and evidence only.</p>}
      {job.error && <p>{job.error}</p>}
      {job.status === "needs_review" && <p>The route and completed work are preserved. Review the failed step before approving a new resume quote.</p>}
      {job.resume_reason && <p>{job.resume_reason}</p>}
      <ol>{job.keyframes.map((kf, i) => <li key={i}>Keyframe {i + 1}: {kf.stage === "source" ? "accepted artwork" : kf.status.replaceAll("_", " ")}{kf.gate ? ` / gate ${kf.gate}` : ""}
        {kf.retry === "reserved" && " / painted twice"}{kf.dropped && <strong> / dropped: {kf.drop_reason}</strong>}{kf.kept_reason && <strong> / {kf.kept_reason}</strong>}
        {job.status === "needs_review" && kf.preview && <a href={`${url}/${encodeURIComponent(job.id)}/keyframes/${i}`} target="_blank" rel="noopener noreferrer" title={`Open preserved keyframe ${i + 1}`}>
          <Image unoptimized width={160} height={100} style={{ objectFit: "contain" }} src={`${url}/${encodeURIComponent(job.id)}/keyframes/${i}`} alt={`Preserved keyframe ${i + 1}`}/></a>}
      </li>)}</ol>
      <ol>{job.legs.map((leg, i) => <li key={i}>Leg {i + 1}: {leg.seconds}s ({leg.duration}s clip)
        {leg.attempts.map((a, n) => <span key={n}> / {a.status.replaceAll("_", " ")}{a.land === undefined ? "" : ` land ${a.land.toFixed(2)}${a.snap === undefined ? "" : ` snap ${a.snap.toFixed(1)}`}`}</span>)}
        {leg.landed === false && <strong> / did not land</strong>}{leg.dropped && <strong> / dropped</strong>}</li>)}</ol>
      {job.status === "needs_review" && job.resume_quote && <>
        <label className={s.checkbox}><input type="checkbox" checked={resumeConsents[job.id] === resumeSignature(job.resume_quote)} disabled={busy || !!pending.current || disabled}
          onChange={e => setResumeConsents(current => ({ ...current, [job.id]: e.target.checked ? resumeSignature(job.resume_quote!) : "" }))}/>
          Resume {job.id}: approve up to {dollars(job.resume_quote.reservation)} (expected {dollars(job.resume_quote.expected_cost)}){job.resume_quote.retry_allowance === 1 ? ", with one consistency retry per remaining step" : ", stored-output recovery only"}</label>
        <button disabled={busy || !!pending.current || disabled || resumeConsents[job.id] !== resumeSignature(job.resume_quote)} onClick={() => void send({ action: "resume", id: job.id, confirmed: true,
          reservation: job.resume_quote!.reservation, source_sha256: job.resume_quote!.source_sha256, job_sha256: job.resume_quote!.job_sha256,
          ...(job.resume_quote!.accepted_anchors_sha256 ? { accepted_anchors_sha256: job.resume_quote!.accepted_anchors_sha256 } : {}) })}>Resume {noun}</button>
      </>}
      {pending.current?.action === "resume" && pending.current.jobId === job.id && <button disabled={busy} onClick={() => void send({ action: "resume", id: job.id })}>Retry same resume request</button>}
      {(job.status === "scheduled" || job.status === "running" || job.status === "submission_unknown" || job.status === "needs_review") &&
        <button title="Cancel path video" aria-label="Cancel path video" disabled={busy} onClick={() => void send({ action: "cancel", id: job.id })}><X size={16}/></button>}
      {job.media && (walk ? <SavedWalkPlayer src={`${url}/${encodeURIComponent(job.id)}/video`} width={job.media.width} height={job.media.height} disabled={disabled}
        mapHref={`/sketch/world?world=${encodeURIComponent(sessionId)}&place=${encodeURIComponent(walk.placeId)}&view=plan`} onError={() => setError("Saved path video unavailable")}/>
        : <video controls playsInline muted preload="metadata" style={{ width: "100%", aspectRatio: `${job.media.width}/${job.media.height}` }}
          src={`${url}/${encodeURIComponent(job.id)}/video`} onError={() => setError("Saved path video unavailable")}/>)}
      {job.media && <p>Review the saved video. Camera and landing checks do not confirm facade identity.</p>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}

// "Make walk video" for a route walked in 3D: a free saved view at each
// eye-level checkpoint (walk-route walkCheckpoints), then the priced panel
// above for one video over those views, in order.
export function WalkVideo({ sessionId, placeId, route, capture, disabled, onPrepared, illustrated = false, initialViewIds = [], refreshKey = 0 }: { sessionId: string; placeId: string; route?: readonly WalkWaypoint[] | undefined; capture: CapturePlaceView | null; disabled: boolean; onPrepared?: ((viewIds: string[]) => void) | undefined; illustrated?: boolean; initialViewIds?: string[]; refreshKey?: number }) {
  const [viewIds, setViewIds] = useState<string[]>(initialViewIds), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reviewRoute, setReviewRoute] = useState(false);
  const [preferReviewed, setPreferReviewed] = useState(false);
  const pending = useRef<{ id: string; label: string; capture: ViewCapture; walk_checkpoint?: true }[] | null>(null);
  const mounted = useRef(true), saving = useRef(false), routeKey = JSON.stringify(route ?? null), currentRoute = useRef(routeKey);
  currentRoute.current = routeKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (routeKey !== "null") { pending.current = null; setViewIds([]); setPreferReviewed(false); setError(""); } }, [routeKey]);
  async function make() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError("");
    try {
      // A retry resends the same ids and captures, so a lost response saves nothing twice.
      // The first illustrated camera is an ordinary saved view: its artwork
      // can be reviewed, accepted and archived before the remaining chain.
      const requests = pending.current ??= walkCheckpoints(route!).map((pose, i, all) => ({ id: crypto.randomUUID(), label: `Walk checkpoint ${i + 1}/${all.length}`, capture: capture!(pose), ...(illustrated && (reviewRoute || i === 0) ? {} : { walk_checkpoint: true as const }) }));
      const ids: string[] = [];
      for (const body of requests) {
        const response = await fetch(`/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(placeId)}/views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) { if (response.status < 500 && pending.current === requests) pending.current = null; throw new Error(data.error || "Walk checkpoint could not be saved"); }
        // The server reuses a current checkpoint saved at the same camera.
        ids.push(data.id);
      }
      if (pending.current === requests) pending.current = null;
      if (mounted.current && currentRoute.current === routeKey) { setViewIds(ids); setPreferReviewed(illustrated && requests.every(request => !request.walk_checkpoint)); onPrepared?.(ids); }
    } catch (e) { if (mounted.current && currentRoute.current === routeKey) setError((e as Error).message); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return <PathVideo sessionId={sessionId} walk={{ placeId, viewIds }} disabled={disabled} refreshKey={refreshKey} preferReviewed={preferReviewed}>
    {illustrated && (route || pending.current) && !viewIds.length && <label className={s.checkbox}><input type="checkbox" checked={reviewRoute} disabled={busy || disabled || !!pending.current} onChange={event => setReviewRoute(event.target.checked)}/>
      Review artwork at every checkpoint (free camera saves)</label>}
    {(route || pending.current) && !viewIds.length && <button disabled={busy || !pending.current && (disabled || !capture)} title="Save a camera view at each checkpoint of this walk (free), then price one video" onClick={() => void make()}>
      <Footprints size={16}/>{busy ? "Saving walk checkpoints..." : pending.current ? "Retry walk checkpoints" : "Make walk video"}</button>}
    {error && <p role="alert">{error}</p>}
  </PathVideo>;
}
