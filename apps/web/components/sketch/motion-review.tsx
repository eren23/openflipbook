"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Pause, Play, Save, Trash2, X } from "lucide-react";
import { evaluateMotionReview, motionSampleSeconds, MOTION_VISUAL_CHECKS, type MotionAssessment, type MotionBounds, type MotionReviewInput } from "@/lib/motion-comparison";
import type { FrozenMotionComparison } from "@/lib/motion-job";
import s from "./motion-review.module.css";

const empty = (): MotionReviewInput => ({ observations: [], visual: { architecture: "unreviewed", occlusion_order: "unreviewed", continuous_motion: "unreviewed" }, notes: "" });
const visualLabels = { architecture: "Architecture and landmark identity", occlusion_order: "Occlusion order", continuous_motion: "Continuous motion between samples" };
function Box({ bounds, reference = false }: { bounds: MotionBounds | null; reference?: boolean }) {
  return bounds && <div className={reference ? s.referenceBox : s.observedBox} style={{ left: `${bounds[0] * 100}%`, top: `${bounds[1] * 100}%`, width: `${(bounds[2] - bounds[0]) * 100}%`, height: `${(bounds[3] - bounds[1]) * 100}%` }}/>;
}
export default function MotionReview({ sessionId, studyId, assetId, comparison, media, initial, onClose, onSave }: {
  sessionId: string; studyId: string; assetId: string; comparison: FrozenMotionComparison;
  media: { width: number; height: number; duration: number }; initial?: MotionReviewInput | undefined;
  onClose(): void; onSave(body: Record<string, unknown>): Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null);
  const [frameIndex, setFrameIndex] = useState(0), [landmarkIndex, setLandmarkIndex] = useState(0);
  const [review, setReview] = useState<MotionReviewInput>(() => structuredClone(initial ?? empty()));
  const [ready, setReady] = useState(false), [referenceReady, setReferenceReady] = useState(false), [error, setError] = useState("");
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false), [draft, setDraft] = useState<MotionBounds | null>(null);
  const [coordinates, setCoordinates] = useState(["", "", "", ""]);
  const pending = useRef<Record<string, unknown> | null>(null), saving = useRef(false), mounted = useRef(true);
  const gesture = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const plan = comparison.plan, frame = plan.frames[frameIndex]!, landmark = plan.landmarks[landmarkIndex]!;
  const sampleSeconds = motionSampleSeconds(plan, frame.seconds, media.duration);
  const selected = review.observations.find(item => item.frame === frameIndex && item.object_id === landmark.id);
  useEffect(() => { setCoordinates(selected?.bounds?.map(n => String(Number((n * 100).toFixed(2)))) ?? ["", "", "", ""]); }, [selected]);
  const blocked = busy || !!pending.current;
  useLayoutEffect(() => {
    mounted.current = true; const element = dialog.current!; element.showModal();
    return () => { mounted.current = false; element.close(); };
  }, []);
  const seek = useCallback(() => {
    const element = video.current; if (!element || !Number.isFinite(element.duration)) return;
    element.pause(); element.currentTime = Math.min(sampleSeconds, Math.max(0, element.duration - .04));
  }, [sampleSeconds]);
  const frameReady = () => {
    const element = video.current;
    const matched = !!element && element.readyState >= 2 && element.paused && !element.seeking && Math.abs(element.currentTime - sampleSeconds) <= plan.tolerances.seek_seconds;
    setReady(matched); setVideoSeconds(element?.currentTime ?? null);
  };
  async function togglePlayback() {
    const element = video.current; if (!element) return;
    if (!element.paused) { element.pause(); return; }
    gesture.current = null; setDraft(null); setReady(false); element.currentTime = 0;
    try { await element.play(); }
    catch { if (mounted.current) setError("Video playback could not start"); }
  }
  useEffect(() => { setReady(false); setDraft(null); gesture.current = null; seek(); }, [seek]);
  function observed(bounds: MotionBounds | null) {
    const element = video.current;
    if (blocked || !ready || !referenceReady || !element || element.seeking || !element.paused || Math.abs(element.currentTime - sampleSeconds) > plan.tolerances.seek_seconds) return;
    setReview(old => ({ ...old, observations: [...old.observations.filter(item => item.frame !== frameIndex || item.object_id !== landmark.id),
      { frame: frameIndex, object_id: landmark.id, observed_seconds: element.currentTime, bounds }] }));
  }
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    pending.current ??= { action: "review", id: assetId, review_id: crypto.randomUUID(), comparison_sha256: comparison.sha256, review: structuredClone(review) };
    try { if (await onSave(pending.current)) { pending.current = null; onClose(); } else setError("Review was not confirmed saved. Retry keeps the same review."); }
    catch { if (mounted.current) setError("Review was not confirmed saved. Retry keeps the same review."); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  const outcome = evaluateMotionReview(plan, review, media);
  return <dialog ref={dialog} className={s.dialog} aria-label="Compare camera motion" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <header className={s.header}><h2>Camera comparison</h2><button aria-label="Close camera comparison" title="Close camera comparison" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className={s.toolbar}>
      <button title="Previous sample" aria-label="Previous sample" disabled={blocked || frameIndex === 0} onClick={() => { setReferenceReady(false); setFrameIndex(i => i - 1); }}><ArrowLeft size={16}/></button>
      <label>Sample<select aria-label="Comparison sample" value={frameIndex} disabled={blocked} onChange={e => { setReferenceReady(false); setFrameIndex(Number(e.target.value)); }}>{plan.frames.map((frame, i) => <option key={i} value={i}>{i + 1} / {frame.seconds.toFixed(2)}s</option>)}</select></label>
      <button title="Next sample" aria-label="Next sample" disabled={blocked || frameIndex === plan.frames.length - 1} onClick={() => { setReferenceReady(false); setFrameIndex(i => i + 1); }}><ArrowRight size={16}/></button>
      <label>Landmark<select aria-label="Comparison landmark" value={landmarkIndex} disabled={blocked} onChange={e => { setDraft(null); gesture.current = null; setLandmarkIndex(Number(e.target.value)); }}>{plan.landmarks.map((item, i) => <option key={item.id} value={i}>{item.label}</option>)}</select></label>
    </div>
    <div className={s.mediaGrid}>
      <div><h3>Geometry reference</h3><div className={s.surface} style={{ aspectRatio: `${plan.width}/${plan.height}` }}>
        <Image key={frameIndex} unoptimized fill sizes="(max-width: 720px) 90vw, 45vw" alt={`Geometry sample ${frameIndex + 1}`} src={`/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId)}/${frameIndex}/render`}
          onLoad={() => setReferenceReady(true)} onError={() => { setReferenceReady(false); setError("Reference image unavailable"); }}/>
        <Box bounds={frame.bounds[landmarkIndex] ?? null} reference/>
      </div></div>
      <div><h3>AI video / human bounds</h3><div className={s.surface} style={{ aspectRatio: `${media.width}/${media.height}` }}>
        <video ref={video} muted playsInline preload="auto" src={`/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(studyId)}/videos/${encodeURIComponent(assetId)}`}
          onLoadedMetadata={seek} onLoadedData={frameReady} onSeeking={() => setReady(false)} onSeeked={frameReady}
          onPlay={() => { setPlaying(true); setReady(false); }} onPause={() => { setPlaying(false); frameReady(); }}
          onTimeUpdate={() => setVideoSeconds(video.current?.currentTime ?? null)}
          onError={() => { setReady(false); setError("Video unavailable"); }}/>
        <div role="img" aria-label="Video landmark bounds" className={s.drawSurface} onPointerDown={event => {
          if (blocked || !ready || !referenceReady || event.button !== 0 || gesture.current) return;
          event.preventDefault(); const p = point(event); gesture.current = { pointer: event.pointerId, ...p }; setDraft(null); event.currentTarget.setPointerCapture?.(event.pointerId);
        }} onPointerMove={event => {
          const start = gesture.current; if (!start || start.pointer !== event.pointerId) return;
          const p = point(event); setDraft([Math.min(start.x, p.x), Math.min(start.y, p.y), Math.max(start.x, p.x), Math.max(start.y, p.y)]);
        }} onPointerUp={event => {
          const start = gesture.current; if (!start || start.pointer !== event.pointerId) return;
          const p = point(event), bounds: MotionBounds = [Math.min(start.x, p.x), Math.min(start.y, p.y), Math.max(start.x, p.x), Math.max(start.y, p.y)];
          gesture.current = null; setDraft(null); if (bounds[2] - bounds[0] >= .002 && bounds[3] - bounds[1] >= .002) observed(bounds);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={() => { gesture.current = null; setDraft(null); }} onLostPointerCapture={() => { gesture.current = null; setDraft(null); }}>
          <Box bounds={draft ?? selected?.bounds ?? null}/>
        </div>
      </div></div>
    </div>
    <div className={s.toolbar}>
      <button title={playing ? "Pause clip" : "Play full clip"} aria-label={playing ? "Pause clip" : "Play full clip"} disabled={blocked} onClick={() => void togglePlayback()}>{playing ? <Pause size={16}/> : <Play size={16}/>}</button>
      <button title="Return to selected sample" disabled={blocked} onClick={seek}>Return to sample</button>
      <output aria-label="Video sample time">{videoSeconds === null ? "Loading video" : `${videoSeconds.toFixed(2)}s / requested ${sampleSeconds.toFixed(2)}s`}</output>
      <label>Visibility<select aria-label="Observed landmark visibility" value={selected ? selected.bounds ? "visible" : "absent" : "unreviewed"} disabled={blocked || !ready || !referenceReady} onChange={event => {
        if (event.target.value === "absent") observed(null);
        else setReview(old => ({ ...old, observations: old.observations.filter(item => item.frame !== frameIndex || item.object_id !== landmark.id) }));
      }}><option value="unreviewed">Unmeasured</option>{selected?.bounds && <option value="visible">Visible / measured</option>}<option value="absent">Absent</option></select></label>
      <button title="Clear landmark measurement" aria-label="Clear landmark measurement" disabled={blocked || !selected} onClick={() => setReview(old => ({ ...old, observations: old.observations.filter(item => item.frame !== frameIndex || item.object_id !== landmark.id) }))}><Trash2 size={16}/></button>
      <output>{review.observations.length} / {plan.frames.length * plan.landmarks.length} measurements</output>
    </div>
    <fieldset className={s.coordinates} disabled={blocked || !ready || !referenceReady}><legend>Visible bounds / image %</legend>{["Left", "Top", "Right", "Bottom"].map((label, i) => <label key={label}>{label}<input aria-label={`Observed ${label.toLowerCase()} percent`} type="number" min={0} max={100} step={.1} value={coordinates[i]} onChange={event => setCoordinates(old => old.map((n, j) => j === i ? event.target.value : n))}/></label>)}
      <button disabled={coordinates.some(n => n === "" || !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 100) || Number(coordinates[0]) >= Number(coordinates[2]) || Number(coordinates[1]) >= Number(coordinates[3])}
        onClick={() => observed(coordinates.map(n => Number(n) / 100) as MotionBounds)}>Apply bounds</button></fieldset>
    <div className={s.checks}>{MOTION_VISUAL_CHECKS.map(key => <label key={key}>{visualLabels[key]}<select aria-label={visualLabels[key]} disabled={blocked} value={review.visual[key]} onChange={event => setReview(old => ({ ...old, visual: { ...old.visual, [key]: event.target.value as MotionAssessment } }))}><option value="unreviewed">Not reviewed</option><option value="pass">Pass</option><option value="fail">Fail</option></select></label>)}</div>
    <label className={s.notes}>Review notes<textarea aria-label="Motion review notes" value={review.notes} maxLength={2000} disabled={blocked} onChange={event => setReview(old => ({ ...old, notes: event.target.value }))}/></label>
    <p role="status" aria-label="Comparison verdict">Human comparison / {outcome.status}</p>
    <ul className={s.issues}>{[...outcome.failures, ...outcome.incomplete].map((issue, i) => <li key={i}>{issue}</li>)}</ul>
    <button disabled={busy} onClick={() => void save()}><Save size={16}/>{busy ? "Saving review..." : pending.current ? "Retry same review" : "Save comparison review"}</button>
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
