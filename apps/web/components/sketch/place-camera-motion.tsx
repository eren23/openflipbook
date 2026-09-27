"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Camera, X } from "lucide-react";
import type { SavedPlaceView } from "@/lib/place-view";
import type { MotionPreparation, MotionReferenceCapture } from "./camera-motion-capture";
import s from "./world-editor.module.css";
import MotionStudyLibrary from "./motion-study-library";

export type CaptureMotion = (view: SavedPlaceView, preparation: MotionPreparation, signal: AbortSignal) => Promise<MotionReferenceCapture>;
export default function PlaceCameraMotion({ sessionId, view, disabled, captureMotion }: {
  sessionId: string; view: SavedPlaceView; disabled: boolean; captureMotion?: CaptureMotion | undefined;
}) {
  const [result, setResult] = useState<MotionReferenceCapture | null>(null), [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/motion`;
  const binding = JSON.stringify([view.id, view.sources, view.assets, view.path, view.accepted_illustration_id, view.historical]);
  useEffect(() => {
    active.current?.abort(); active.current = null;
    setResult(null); setIndex(0); setBusy(false); setError("");
    return () => { active.current?.abort(); active.current = null; };
  }, [binding, disabled]);
  async function prepare() {
    if (disabled || !captureMotion || active.current) return;
    const abort = new AbortController(); active.current = abort; setBusy(true); setError(""); setResult(null);
    try {
      const read = async (): Promise<MotionPreparation> => {
        const response = await fetch(endpoint, { cache: "no-store", signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Motion preparation unavailable");
        return data;
      };
      const preparation = await read();
      const captured = await captureMotion(view, preparation, abort.signal);
      abort.signal.throwIfAborted();
      const latest = await read();
      if (latest.preparation_sha256 !== preparation.preparation_sha256) throw new Error("Motion source changed. Prepare it again.");
      if (active.current === abort) { setResult(captured); setIndex(0); }
    } catch (e) { if (active.current === abort && !abort.signal.aborted) setError((e as Error).message); }
    finally { if (active.current === abort) { active.current = null; setBusy(false); } }
  }
  const frame = result?.frames[index];
  const target = frame?.measurements.landmarks.find(item => item.object_id === view.path?.target_id);
  return <div className={s.illustrationGenerator} aria-label="Camera motion references">
    <div className={s.sectionHeading}><h3>Camera motion</h3>{busy && <button aria-label="Cancel motion preparation" title="Cancel motion preparation" onClick={() => { active.current?.abort(); active.current = null; setBusy(false); }}><X size={16}/></button>}</div>
    <button disabled={disabled || busy || view.historical || !captureMotion} onClick={() => void prepare()}><Camera size={16}/>{busy ? "Preparing references..." : "Prepare motion references"}</button>
    {error && <p role="alert">{error}</p>}
    {frame && result && <>
      <p role="status">Geometry reference / {result.preflight.status === "clear" ? "Clearance checked" : "Path blocked"} / H3 uncalibrated</p>
      <div aria-label="Local comparison readiness">
        <p>Local comparison reference / {result.comparison.issues.length ? "incomplete" : "ready"}</p>
        <p>{result.comparison.landmarks.map(item => item.label).join(", ")}</p>
        {!!result.comparison.issues.length && <ul>{result.comparison.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      </div>
      <div style={{ position: "relative", aspectRatio: `${view.width} / ${view.height}`, width: "100%" }}>
        <Image unoptimized src={frame.capture.passes.render} alt={`Motion geometry reference at ${frame.seconds.toFixed(2)} seconds`} fill sizes="320px" style={{ objectFit: "contain" }}/>
      </div>
      <label>Reference time<input aria-label="Motion reference time" type="range" min={0} max={result.frames.length - 1} step={1} value={index} onChange={e => setIndex(Number(e.target.value))}/></label>
      <p>{frame.seconds.toFixed(2)}s / {view.path!.duration}s / {target?.pixels ? `${target.pixels.toLocaleString()} target pixels${target.touches_frame ? " / touches frame" : ""}` : "Target not visible"}</p>
    </>}
    <MotionStudyLibrary key={`studies:${sessionId}:${view.id}`} sessionId={sessionId} view={view} reference={result} disabled={disabled || busy}/>
  </div>;
}
