"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Pause, Play, RotateCcw, X } from "lucide-react";
import * as THREE from "three";
import { applyCamera, WORLD, type CameraView } from "../lighthouse-v2/contract";
import reference from "../lighthouse-v2/reference.png";
import styles from "../lighthouse-v2/study.module.css";
import { appearance, makeWorld, type SurfaceMode } from "./world";
import { INITIAL, KEY, restore, type State } from "./state";

// Separate study controller keeps the hash-frozen v2 experiment untouched.
export default function Study() {
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ ...INITIAL }), current = useRef(state);
  const [running, setRunning] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const draw = useRef<(s: State) => void>(() => {});
  const commit = useCallback((s: State) => { current.current = s; setState(s); draw.current(s); }, []);
  const save = useCallback(() => { try { localStorage.setItem(KEY, JSON.stringify(current.current)); } catch { /* Optional study state only. */ } }, []);
  useEffect(() => {
    let renderer: THREE.WebGLRenderer | undefined, world: ReturnType<typeof makeWorld> | undefined, observer: ResizeObserver | undefined;
    const el = host.current!;
    try {
      try { current.current = restore(localStorage.getItem(KEY)); } catch { current.current = { ...INITIAL }; }
      world = makeWorld(); renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
      const canvas = renderer.domElement; canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Lighthouse surface comparison"); el.appendChild(canvas);
      const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 16 / 9, WORLD.camera.near, WORLD.camera.far);
      draw.current = s => {
        const width = el.clientWidth, height = el.clientHeight;
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) renderer!.setSize(width, height);
        camera.aspect = width / height; camera.fov = camera.aspect < 1 ? 64 : WORLD.camera.fov;
        camera.updateProjectionMatrix(); applyCamera(camera, s.time, s.view); world!.setMode(s.mode);
        renderer!.render(world!.scene, camera);
        canvas.dataset.ready = "true"; canvas.dataset.asset = appearance.id; canvas.dataset.geometry = WORLD.id;
        canvas.dataset.mode = s.mode; canvas.dataset.time = s.time.toFixed(3); canvas.dataset.view = s.view;
        canvas.dataset.pose = JSON.stringify(camera.matrixWorld.toArray());
      };
      observer = new ResizeObserver(() => draw.current(current.current)); observer.observe(el); commit(current.current); setReady(true);
    } catch (e) { setError(`Surface study unavailable: ${String(e)}`); }
    const hide = () => { if (document.hidden) { setRunning(false); save(); } };
    document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", save);
    return () => { save(); draw.current = () => {}; observer?.disconnect(); world?.dispose(); renderer?.dispose(); el.replaceChildren(); document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", save); };
  }, [commit, save]);
  useEffect(() => {
    if (!running) return;
    let frame = 0, previous: number | undefined;
    const tick = (now: number) => {
      const delta = previous === undefined ? 0 : Math.min(.1, (now - previous) / 1000); previous = now;
      const time = Math.min(WORLD.duration, current.current.time + delta); commit({ ...current.current, time });
      if (time === WORLD.duration) { setRunning(false); save(); } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [running, commit, save]);
  const change = (patch: Partial<State>) => { setRunning(false); commit({ ...current.current, ...patch }); save(); };
  const play = () => {
    if (running) { setRunning(false); save(); return; }
    commit({ ...current.current, view: "walk", time: current.current.time >= WORLD.duration ? 0 : current.current.time }); setRunning(true);
  };
  return <main className={styles.main}>
    <header className={styles.header}>
      <div className={styles.title}><h1>Crystal Lighthouse</h1><span>Fixed surfaces / geometry v2</span></div>
      <select aria-label="Camera view" value={state.view} disabled={!ready} onChange={e => change({ view: e.target.value as CameraView })}><option value="walk">Ground route</option><option value="inspection">Oblique inspection</option></select>
      <select aria-label="Surface treatment" value={state.mode} disabled={!ready} onChange={e => change({ mode: e.target.value as SurfaceMode })}><option value="surface">Surface pass</option><option value="baseline">V2 baseline</option><option value="clay">Clay</option></select>
      <button title="Source review" aria-label="Source review" onClick={() => { setRunning(false); save(); dialog.current?.showModal(); }}><ImageIcon size={18} /></button>
    </header>
    <div className={styles.stage} ref={host} />
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer className={styles.footer}>
      <div className={styles.transport}>
        <button title={running ? "Pause route" : "Play route"} aria-label={running ? "Pause route" : "Play route"} disabled={!ready} onClick={play}>{running ? <Pause size={18} /> : <Play size={18} />}</button>
        <button title="Return to arrival" aria-label="Return to arrival" disabled={!ready} onClick={() => change({ time: 0, view: "walk" })}><RotateCcw size={18} /></button>
        <input aria-label="Route position" type="range" min={0} max={WORLD.duration} step={.05} value={state.time} disabled={!ready || state.view !== "walk"} onChange={e => change({ time: Number(e.target.value) })} />
        <output aria-label="Route time">{state.time.toFixed(1)} / {WORLD.duration}s</output>
      </div>
      <nav aria-label="Route stops">{WORLD.route.filter(p => p.time !== 20).map(p => <button key={p.time} disabled={!ready} aria-current={state.view === "walk" && Math.abs(state.time - p.time) < .05 ? "step" : undefined} onClick={() => change({ time: p.time, view: "walk" })}>{p.label}</button>)}</nav>
    </footer>
    <dialog ref={dialog} className={styles.dialog} aria-label="Source review">
      <header><h2>Source review</h2><button title="Close source review" aria-label="Close source review" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
      <div className={styles.evidence}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={reference.src} alt="Original lighthouse architecture and illustrated palette" />
        <div><p>Authored surface study. Fidelity not accepted.</p><h3>Unresolved structure</h3><ul>{appearance.structuralReview.map(note => <li key={note}>{note}</li>)}</ul><h3>Provenance</h3><p>{appearance.method}.</p><p>Geometry and camera path are unchanged from v2. No new model output.</p></div>
      </div>
    </dialog>
  </main>;
}
