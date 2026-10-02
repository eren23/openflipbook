"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Save } from "lucide-react";
import type { SavedPlaceView } from "@/lib/place-view";
import type { MotionStudy } from "@/lib/motion-study";
import type { MotionReferenceCapture } from "./camera-motion-capture";
import s from "./world-editor.module.css";
import MotionGeneration from "./motion-generation";
import PathVideo from "./path-video";

export default function MotionStudyLibrary({ sessionId, view, reference, disabled }: {
  sessionId: string; view: SavedPlaceView; reference: MotionReferenceCapture | null; disabled: boolean;
}) {
  const [studies, setStudies] = useState<MotionStudy[]>([]), [selected, setSelected] = useState("");
  const [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<string | null>(null), mounted = useRef(true), saving = useRef(false), reads = useRef({ version: 0 });
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/motion/studies`;
  const reload = useCallback(async () => {
    const read = ++reads.current.version, response = await fetch(endpoint, { cache: "no-store" }), data = await response.json();
    if (!mounted.current || read !== reads.current.version) return;
    if (!response.ok || !Array.isArray(data.studies)) throw new Error(data.error || "Motion studies unavailable");
    setStudies(data.studies); setSelected(old => data.studies.some((study: MotionStudy) => study.id === old) ? old : data.studies[0]?.id ?? "");
  }, [endpoint]);
  useEffect(() => {
    const state = reads.current;
    mounted.current = true;
    void reload().catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; state.version++; };
  }, [reload, view.historical, view.accepted_illustration_id]);
  async function save() {
    if (saving.current || !pending.current && (disabled || !reference)) return;
    saving.current = true; setBusy(true); setError(""); reads.current.version++;
    try {
      pending.current ??= JSON.stringify({ id: crypto.randomUUID(), label: `${view.label} motion`.slice(0, 120),
        preparation_sha256: reference!.preparation_sha256, client_preflight: reference!.preflight,
        frames: reference!.frames.map(({ time, seconds, capture }) => ({ time, seconds, capture })) });
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: pending.current });
      const data = await response.json();
      if (!response.ok) {
        if ([400, 403, 404, 409, 413, 429].includes(response.status)) pending.current = null;
        throw new Error(data.error || "Motion study save failed");
      }
      pending.current = null;
      await reload();
      if (mounted.current) { setSelected(data.id); setIndex(0); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  const study = studies.find(item => item.id === selected), frame = study?.frames[index];
  return <div aria-label="Saved motion studies" className={s.illustrationGenerator}>
    {(reference || pending.current) && <button disabled={busy || !pending.current && disabled} onClick={() => void save()}><Save size={16}/>{busy ? "Saving motion study..." : pending.current ? "Retry motion study save" : "Save motion study"}</button>}
    {!!studies.length && <>
      <label>Saved motion study<select aria-label="Saved motion study" disabled={busy} value={selected} onChange={e => { setSelected(e.target.value); setIndex(0); }}>{studies.map(item => <option key={item.id} value={item.id}>{item.label}{item.historical ? " / historical" : ""}</option>)}</select></label>
      {study && frame && <>
        <p role="status">Saved geometry reference / {study.historical ? "Historical source" : "Current source"}</p>
        <p>Local path check: {study.client_preflight?.status ?? "not recorded"} / not server verified</p>
        {!!study.client_preflight?.issues.length && <ul>{study.client_preflight.issues.map((issue, i) => <li key={i}>{issue.kind === "collision" ? "Collision" : "Target occluded"}: {(issue.time * study.frames.at(-1)!.seconds).toFixed(2)}s - {(issue.end_time * study.frames.at(-1)!.seconds).toFixed(2)}s</li>)}</ul>}
        <div style={{ position: "relative", width: "100%", aspectRatio: `${view.width} / ${view.height}` }}><Image unoptimized fill sizes="320px" style={{ objectFit: "contain" }} src={`/api/world/${encodeURIComponent(sessionId)}/motion-studies/${encodeURIComponent(study.id)}/${index}/render`} alt={`Saved motion reference at ${frame.seconds.toFixed(2)} seconds`} onError={() => setError("Saved reference image unavailable")}/></div>
        <label>Saved reference time<input aria-label="Saved motion reference time" type="range" min={0} max={study.frames.length - 1} step={1} value={index} onChange={e => setIndex(Number(e.target.value))}/></label>
        <p>{frame.seconds.toFixed(2)}s / {study.frames.at(-1)?.seconds}s</p>
        <MotionGeneration key={study.id} sessionId={sessionId} studyId={study.id} disabled={disabled} onTime={seconds => setIndex(study.frames.reduce((closest, item, i) => Math.abs(item.seconds - seconds) < Math.abs(study.frames[closest]!.seconds - seconds) ? i : closest, 0))}/>
        <PathVideo key={`path-${study.id}`} sessionId={sessionId} studyId={study.id} disabled={disabled}/>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
