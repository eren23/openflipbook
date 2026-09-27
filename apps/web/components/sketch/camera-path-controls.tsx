"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown, ChevronUp, Crosshair, Pause, Play, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { insertCameraKeyframe, sampleCameraPath, type CameraKeyframe, type CameraRig, type OrbitPose, type CameraPathCheck, type CameraPathDraft } from "@/lib/camera-path";
import s from "./camera-path-controls.module.css";

export default function CameraPathControls({ rig, selected, initialPath }: { rig: CameraRig; selected?: string | null | undefined; initialPath?: CameraPathDraft | undefined }) {
  const [open, setOpen] = useState(!!initialPath), [frames, setFrames] = useState<CameraKeyframe[]>(initialPath?.keyframes ?? []);
  const [time, setTime] = useState(initialPath?.time ?? 0), [duration, setDuration] = useState(initialPath?.duration ?? 6), [playing, setPlaying] = useState(false);
  const [target, setTarget] = useState(initialPath ? rig.targetLabel() : "Scene centre");
  useEffect(() => { rig.draft?.(frames.length ? { keyframes: frames, time, duration } : null); }, [rig, frames, time, duration]);
  useEffect(() => () => rig.draft?.(null), [rig]);
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState("");
  const [checked, setChecked] = useState<{ frames: CameraKeyframe[]; report: CameraPathCheck } | null>(null);
  const checkEpoch = useRef(0);
  const report = checked?.frames === frames ? checked.report : null;
  const active = frames.findIndex(frame => Math.abs(frame.time - time) < 0.001);
  const pose = frames.length ? sampleCameraPath(frames, time) : null;
  const latest = useRef({ frames, time }); latest.current = { frames, time };
  const cancelCheck = () => { checkEpoch.current++; setChecking(false); };
  useEffect(() => {
    const epoch = checkEpoch;
    epoch.current++; setChecking(false); setCheckError(""); setChecked(null);
    return () => { epoch.current++; };
  }, [frames, rig, open]);
  const check = async (play: boolean) => {
    const epoch = ++checkEpoch.current, frozen = frames;
    setPlaying(false); setChecking(true); setCheckError("");
    try {
      const result = await rig.check(frozen);
      if (epoch !== checkEpoch.current || latest.current.frames !== frozen) return;
      setChecked({ frames: frozen, report: result });
      if (play && result.status === "clear") setPlaying(true);
    } catch (error) {
      if (epoch === checkEpoch.current) { setChecked(null); setCheckError(error instanceof Error ? error.message : "Camera path check failed"); }
    } finally { if (epoch === checkEpoch.current) setChecking(false); }
  };
  const reset = () => {
    cancelCheck();
    setPlaying(false); setTarget(rig.targetSelection());
    const start = rig.read(); setFrames([{ ...start, time: 0 }, { ...start, time: 1 }]); setTime(0);
  };
  useEffect(() => { rig.setActive(open); return () => rig.setActive(false); }, [rig, open]);
  useEffect(() => rig.subscribe(event => {
    checkEpoch.current++; setChecking(false);
    if (event === "start") setChecked(null);
    setPlaying(false);
    if (event === "reset") {
      const value = rig.read(); setTarget(rig.targetLabel()); setTime(0);
      setFrames([{ ...value, time: 0 }, { ...value, time: 1 }]);
    }
    if (event === "end") {
      const value = rig.read(), { time: at, frames: previous } = latest.current;
      if (!previous.length) return;
      const expanded = insertCameraKeyframe(previous, at);
      // At the frame limit (or beside a marker), keep the manually moved pose
      // attached to the nearest keyframe instead of showing stale controls.
      const nearest = expanded.reduce((best, frame, index) => Math.abs(frame.time - at) < Math.abs(expanded[best]!.time - at) ? index : best, 0);
      setTime(expanded[nearest]!.time);
      setFrames(expanded.map((frame, index) => index === nearest ? { ...frame, ...value } : frame));
    }
  }), [rig]);
  useEffect(() => {
    if (!playing) return;
    const startTime = performance.now(), start = latest.current.time >= 1 ? 0 : latest.current.time;
    const path = latest.current.frames;
    let handle = 0;
    const step = (now: number) => {
      const next = Math.min(1, start + (now - startTime) / (duration * 1000));
      rig.write(sampleCameraPath(path, next)); setTime(next);
      if (next === 1) setPlaying(false); else handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [playing, duration, rig]);
  const seek = (next: number) => { cancelCheck(); setPlaying(false); setTime(next); rig.write(sampleCameraPath(frames, next)); };
  const edit = (field: keyof OrbitPose, value: number) => {
    if (active < 0 || !Number.isFinite(value)) return;
    cancelCheck();
    setPlaying(false);
    const limits = field === "azimuth" ? [-720, 720] : field === "elevation" ? [rig.minElevation, rig.maxElevation] : [rig.minDistance, rig.maxDistance];
    const next = { ...pose!, [field]: Math.max(limits[0]!, Math.min(limits[1]!, value)) };
    setFrames(frames.map((frame, index) => index === active ? { ...next, time: frame.time } : frame)); rig.write(next);
  };
  return <section className={s.panel} aria-label="Camera path" data-camera-path-open={open}>
    <button className={s.heading} aria-expanded={open} onClick={() => { cancelCheck(); if (!open && !frames.length) reset(); setOpen(!open); setPlaying(false); }}>
      <Camera size={17}/> Camera path {open ? <ChevronDown size={16}/> : <ChevronUp size={16}/>}
    </button>
    {open && pose && <div className={s.content}>
      <div className={s.row}><span className={s.target}>{target}</span><span className={s.status}>Path draft</span>
        <button title={selected ? "Start new path around selected object" : "Start new path around scene centre"} aria-label="Reset camera path target" onClick={reset}><Crosshair size={17}/></button>
      </div>
      <div className={s.axes}>{([
        ["azimuth", "Azimuth", -720, 720, 1, "deg"],
        ["elevation", "Elevation", rig.minElevation, rig.maxElevation, 1, "deg"],
        ["distance", "Distance", rig.minDistance, rig.maxDistance, 0.1, "m"],
      ] as const).map(([field, label, min, max, step, unit]) => <div key={field} className={s.axis}>
        <label>{label}<span><input aria-label={`${label} value`} type="number" min={min} max={max} step={step} disabled={active < 0 || playing} value={Number(pose[field].toFixed(1))} onChange={e => { if (e.target.value !== "") edit(field, Number(e.target.value)); }}/>{unit}</span></label>
        <input aria-label={label} type="range" min={min} max={max} step={step} disabled={active < 0 || playing} value={pose[field]} onChange={e => edit(field, Number(e.target.value))}/>
      </div>)}</div>
      <div className={s.timeline}>
        <input aria-label="Camera timeline" type="range" min={0} max={1} step={0.001} value={time} onChange={e => seek(Number(e.target.value))}/>
        <div className={s.keyframes}>{frames.map((frame, index) => <button key={frame.time} title={`Keyframe ${index + 1}: ${(frame.time * duration).toFixed(1)}s`} aria-label={`Camera keyframe ${index + 1}`} aria-pressed={index === active} style={{ left: `${frame.time * 100}%` }} onClick={() => seek(frame.time)}><span/></button>)}</div>
      </div>
      <div className={s.row}>
        <button title={playing ? "Pause camera path" : "Play camera path"} aria-label={playing ? "Pause camera path" : "Play camera path"} disabled={!playing && (checking || report?.status === "blocked")} onClick={() => { if (playing) setPlaying(false); else void check(true); }}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button>
        <button title="Rewind camera path" aria-label="Rewind camera path" onClick={() => seek(0)}><RotateCcw size={17}/></button>
        <output className={s.time}>{(time * duration).toFixed(1)} / {duration}s</output>
        <label className={s.duration}>Duration<select aria-label="Camera path duration" value={duration} onChange={e => { cancelCheck(); setPlaying(false); setDuration(Number(e.target.value)); }}>{[...new Set([5, 6, 8, 10, 12, 15, duration])].sort((a, b) => a - b).map(seconds => <option key={seconds} value={seconds}>{seconds}s</option>)}</select></label>
        <button title="Add camera keyframe" aria-label="Add camera keyframe" disabled={active >= 0 || frames.length >= 12 || playing || frames.some(frame => Math.abs(frame.time - time) < 0.01)} onClick={() => { cancelCheck(); setFrames(insertCameraKeyframe(frames, time)); }}><Plus size={17}/></button>
        <button title="Delete camera keyframe" aria-label="Delete camera keyframe" disabled={active <= 0 || active === frames.length - 1 || playing} onClick={() => { cancelCheck(); setFrames(frames.filter((_, index) => index !== active)); }}><Trash2 size={17}/></button>
        <button title="Check camera path" aria-label="Check camera path" disabled={checking || playing} onClick={() => void check(false)}><ShieldCheck size={17}/></button>
      </div>
      <div className={s.check} aria-label="Camera path validation">
        <span role="status">{checking ? "Checking geometry..." : report ? report.status === "blocked" ? "Path blocked" : `Camera clearance passed / ${report.visibility === "sampled" ? "Target centre sampled" : "No target selected"}` : "Path unchecked"}</span>
        {checkError && <span role="alert">{checkError}</span>}
        {!!report?.issues.length && <div className={s.issues}>{report.issues.map((issue, index) => <button key={index} title={`${issue.kind === "collision" ? "Collision risk" : "Target centre occluded"}: ${(issue.time * duration).toFixed(2)}-${(issue.end_time * duration).toFixed(2)}s`} onClick={() => seek(issue.time)}>{issue.kind === "collision" ? "Collision risk" : "Target occluded"} at {(issue.time * duration).toFixed(1)}s</button>)}</div>}
      </div>
    </div>}
  </section>;
}
