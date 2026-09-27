"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Pause, Play, RotateCcw, X } from "lucide-react";
import * as THREE from "three";
import { applyCamera, INITIAL, readSnapshot, STORAGE_KEY, WORLD, type CameraView, type Mode, type Snapshot } from "./contract";
import { makeWorld } from "./world";
import reference from "./reference.png";
import styles from "./study.module.css";

export default function Study() {
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ ...INITIAL });
  const current = useRef(snapshot), draw = useRef<(s: Snapshot) => void>(() => {});
  const [running, setRunning] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const commit = useCallback((next: Snapshot) => { current.current = next; setSnapshot(next); draw.current(next); }, []);
  const save = useCallback(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current.current)); } catch { /* Storage is optional for this local study. */ } }, []);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer | undefined, world: ReturnType<typeof makeWorld> | undefined, observer: ResizeObserver | undefined;
    try {
      try { current.current = readSnapshot(localStorage.getItem(STORAGE_KEY)); } catch { current.current = { ...INITIAL }; }
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const canvas = renderer.domElement; canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Persistent lighthouse scene");
      el.appendChild(canvas); world = makeWorld();
      const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 16 / 9, WORLD.camera.near, WORLD.camera.far);
      draw.current = s => {
        const width = el.clientWidth, height = el.clientHeight;
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) renderer!.setSize(width, height);
        camera.aspect = width / height; camera.fov = camera.aspect < 1 ? 64 : WORLD.camera.fov;
        camera.updateProjectionMatrix(); applyCamera(camera, s.time, s.view); world!.setMode(s.mode); renderer!.render(world!.scene, camera);
        canvas.dataset.ready = "true"; canvas.dataset.scene = WORLD.id; canvas.dataset.time = s.time.toFixed(3);
        canvas.dataset.mode = s.mode; canvas.dataset.view = s.view; canvas.dataset.pose = JSON.stringify(camera.matrixWorld.toArray());
        canvas.dataset.height = String(camera.position.y);
      };
      observer = new ResizeObserver(() => draw.current(current.current)); observer.observe(el);
      commit(current.current); setReady(true);
    } catch (e) { setError(`Scene unavailable: ${String(e)}`); }
    const pause = () => { if (document.hidden) { setRunning(false); save(); } };
    document.addEventListener("visibilitychange", pause);
    window.addEventListener("pagehide", save);
    return () => {
      save(); draw.current = () => {}; observer?.disconnect(); renderer?.dispose(); world?.dispose(); el.replaceChildren();
      document.removeEventListener("visibilitychange", pause); window.removeEventListener("pagehide", save);
    };
  }, [commit, save]);

  useEffect(() => {
    if (!running) { if (ready) save(); return; }
    let frame = 0, previous: number | undefined;
    const tick = (now: number) => {
      const step = previous === undefined ? 0 : Math.min(.1, (now - previous) / 1000); previous = now;
      const time = Math.min(WORLD.duration, current.current.time + step);
      commit({ ...current.current, time });
      if (time >= WORLD.duration) { setRunning(false); save(); }
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, ready, commit, save]);

  const change = (patch: Partial<Snapshot>) => { setRunning(false); commit({ ...current.current, ...patch }); save(); };
  function play() {
    if (running) { setRunning(false); save(); return; }
    commit({ ...current.current, view: "walk", time: current.current.time >= WORLD.duration ? 0 : current.current.time });
    setRunning(true);
  }
  return <main className={styles.main}>
    <header className={styles.header}>
      <div className={styles.title}><h1>Crystal Lighthouse</h1><span>Authored v2 / exterior only</span></div>
      <select aria-label="Camera view" value={snapshot.view} disabled={!ready} onChange={e => change({ view: e.target.value as CameraView })}>
        <option value="walk">Ground route</option><option value="inspection">Oblique inspection</option>
      </select>
      <select aria-label="Render mode" value={snapshot.mode} disabled={!ready} onChange={e => change({ mode: e.target.value as Mode })}>
        <option value="color">Color</option><option value="clay">Clay</option><option value="depth">Depth</option>
      </select>
      <button title="Source evidence" aria-label="Source evidence" onClick={() => { setRunning(false); dialog.current?.showModal(); }}><ImageIcon size={18} /></button>
    </header>
    <div className={styles.stage} ref={host} />
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}>
      <div className={styles.transport}>
        <button title={running ? "Pause route" : "Play route"} aria-label={running ? "Pause route" : "Play route"} disabled={!ready} onClick={play}>{running ? <Pause size={18} /> : <Play size={18} />}</button>
        <button title="Return to arrival" aria-label="Return to arrival" disabled={!ready} onClick={() => change({ time: 0, view: "walk" })}><RotateCcw size={18} /></button>
        <input type="range" aria-label="Route position" min={0} max={WORLD.duration} step={.05} value={snapshot.time} disabled={!ready || snapshot.view !== "walk"} onChange={e => change({ time: Number(e.target.value) })} />
        <output aria-label="Route time">{snapshot.time.toFixed(1)} / {WORLD.duration}s</output>
      </div>
      <nav aria-label="Route stops">{WORLD.route.filter(p => p.time !== 20).map(p => <button key={p.time} disabled={!ready} aria-current={snapshot.view === "walk" && Math.abs(snapshot.time - p.time) < .05 ? "step" : undefined} onClick={() => change({ time: p.time, view: "walk" })}>{p.label}</button>)}</nav>
    </footer>
    <dialog ref={dialog} className={styles.dialog} aria-label="Source evidence">
      <header><h2>Source evidence</h2><button aria-label="Close source evidence" title="Close" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
      <div className={styles.evidence}>
        {/* The original crop is evidence, not a texture pretending to reconstruct hidden walls. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={reference.src} alt="Original Crystal Lighthouse crop with faceted base, arched annex and open crown" />
        <div><p>{WORLD.provenance}. Dimensions are estimates.</p>{WORLD.features.map(feature => <section key={feature.id}><h3>{feature.id}</h3><p>{feature.observed}</p><p className={styles.muted}>Assumed: {feature.assumed}</p></section>)}<h3>Unknown</h3><ul>{WORLD.unknown.map(item => <li key={item}>{item}</li>)}</ul></div>
      </div>
    </dialog>
  </main>;
}
