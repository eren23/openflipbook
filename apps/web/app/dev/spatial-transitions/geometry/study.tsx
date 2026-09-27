"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Download, Maximize, Paintbrush, Pause, Play, RotateCcw, RotateCw, SkipBack } from "lucide-react";
import * as THREE from "three";
import { BOOKMARKS, WORLD, poseAt, proposedStep, type Pose, type RenderMode } from "./contract";
import { applyPose, makeWorld } from "./world";
import styles from "./study.module.css";

interface Viewport {
  render: (pose: Pose, time: number, mode: RenderMode) => void;
  canMove: (from: Pose["position"], to: Pose["position"]) => boolean;
}

export default function GeometryStudy() {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<Viewport | null>(null);
  const current = useRef({ time: 0, pose: poseAt(0), mode: "illustrated" as RenderMode });
  const [time, setTime] = useState(0);
  const [pose, setPose] = useState<Pose>(poseAt(0));
  const [mode, setMode] = useState<RenderMode>("illustrated");
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  const show = useCallback((nextPose: Pose, nextTime: number) => {
    current.current = { ...current.current, pose: nextPose, time: nextTime };
    viewport.current?.render(nextPose, nextTime, current.current.mode);
    setPose(nextPose); setTime(nextTime);
  }, []);
  const seek = useCallback((value: number) => { setPlaying(false); setBlocked(false); show(poseAt(value), value); }, [show]);
  const walk = useCallback((forward: number, sideways: number, turn = 0) => {
    if (!viewport.current) return;
    setPlaying(false);
    const from = current.current.pose;
    const candidate = proposedStep(from, forward, sideways);
    candidate.yaw += turn;
    if (viewport.current.canMove(from.position, candidate.position)) { show(candidate, current.current.time); setBlocked(false); }
    else setBlocked(true);
  }, [show]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let world: ReturnType<typeof makeWorld> | undefined;
    let resize: ResizeObserver | undefined;
    const lost = (event: Event) => { event.preventDefault(); setError("3D rendering was interrupted. Reload this view to reconnect."); setPlaying(false); setReady(false); };
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const canvas = renderer.domElement;
      canvas.setAttribute("aria-label", "Quayside three-dimensional scene");
      canvas.setAttribute("role", "img"); canvas.dataset.scene = WORLD.id;
      canvas.addEventListener("webglcontextlost", lost);
      element.appendChild(canvas);
      world = makeWorld();
      const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 1, WORLD.camera.near, WORLD.camera.far);
      const render = (next: Pose, nextTime: number, nextMode: RenderMode) => {
        applyPose(camera, next); world!.setMode(nextMode); renderer!.render(world!.scene, camera);
        canvas.dataset.time = nextTime.toFixed(6); canvas.dataset.mode = nextMode;
        canvas.dataset.pose = JSON.stringify(next); canvas.dataset.ready = "true";
      };
      viewport.current = { render, canMove: world.canMove };
      const fit = () => {
        const { width, height } = element.getBoundingClientRect();
        if (!width || !height) return;
        renderer!.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
        render(current.current.pose, current.current.time, current.current.mode);
      };
      resize = new ResizeObserver(fit); resize.observe(element); fit(); setReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : "3D rendering is unavailable."); }
    return () => {
      viewport.current = null; resize?.disconnect(); world?.dispose();
      if (renderer) { renderer.domElement.removeEventListener("webglcontextlost", lost); renderer.dispose(); renderer.domElement.remove(); }
    };
  }, []);

  useEffect(() => {
    if (!playing || !ready) return;
    let id = 0;
    const start = performance.now(), offset = current.current.time;
    const tick = (now: number) => {
      const next = Math.min(WORLD.duration, offset + (now - start) / 1000);
      show(poseAt(next), next);
      if (next < WORLD.duration) id = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, ready, show]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,select,button,a,textarea")) return;
      const actions: Record<string, () => void> = { w: () => walk(.25, 0), s: () => walk(-.25, 0),
        a: () => walk(0, -.25), d: () => walk(0, .25), ArrowUp: () => walk(.25, 0), ArrowDown: () => walk(-.25, 0),
        ArrowLeft: () => walk(0, 0, .12), ArrowRight: () => walk(0, 0, -.12) };
      if (actions[event.key]) { event.preventDefault(); actions[event.key]!(); }
    };
    const visibility = () => { if (document.hidden) setPlaying(false); };
    window.addEventListener("keydown", key); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("visibilitychange", visibility); };
  }, [walk]);

  function setRenderMode(next: RenderMode) {
    current.current.mode = next; setMode(next);
    viewport.current?.render(current.current.pose, current.current.time, next);
  }
  function downloadScene() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...WORLD, selected_camera: current.current.pose }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${WORLD.id}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const tools = [{ label: "Turn left", Icon: RotateCcw, action: () => walk(0, 0, .15) },
    { label: "Walk forward", Icon: ArrowUp, action: () => walk(.4, 0) },
    { label: "Turn right", Icon: RotateCw, action: () => walk(0, 0, -.15) },
    { label: "Step left", Icon: ArrowLeft, action: () => walk(0, -.4) },
    { label: "Walk backward", Icon: ArrowDown, action: () => walk(-.4, 0) },
    { label: "Step right", Icon: ArrowRight, action: () => walk(0, .4) }];

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/dev/spatial-transitions" aria-label="Back to transition studies" title="Transition studies" className={styles.icon}><ArrowLeft size={18} /></Link>
      <div className={styles.identity}><span className={styles.brand}>openflipbook</span><span className={styles.title}>Quayside Provisions</span></div>
      <div className={styles.modes} role="group" aria-label="Render mode">
        <button aria-label="Illustrated" aria-pressed={mode === "illustrated"} onClick={() => setRenderMode("illustrated")} title="Illustrated materials"><Paintbrush size={16} /><span>Illustrated</span></button>
        <button aria-label="Clay" aria-pressed={mode === "clay"} onClick={() => setRenderMode("clay")} title="Plain geometry"><Box size={16} /><span>Clay</span></button>
      </div>
      <button className={styles.icon} title="Download scene and camera" aria-label="Download scene" onClick={downloadScene}><Download size={18} /></button>
    </header>
    <div className={styles.stage}>
      <div className={styles.canvas} ref={host} data-testid="geometry-stage" />
      {!ready && !error && <div role="status" className={styles.notice}>Loading scene...</div>}
      {error && <div role="alert" className={styles.notice}>{error}<button onClick={() => window.location.reload()}>Reload</button></div>}
      <div className={styles.location}><span className={styles.dot} /><span>{pose.label}</span><span className={styles.version}>3D study / v{WORLD.version}</span></div>
      <button className={`${styles.icon} ${styles.fullscreen}`} title="Fullscreen" aria-label="Fullscreen" onClick={() => { void host.current?.parentElement?.requestFullscreen().catch(() => setError("Fullscreen unavailable in this browser.")); }}><Maximize size={17} /></button>
      <div className={styles.movement} role="group" aria-label="Camera movement">
        {tools.map(({ label, Icon, action }) => <button key={label} className={styles.icon} title={label} aria-label={label} disabled={!ready} onClick={action}><Icon size={19} /></button>)}
      </div>
      {blocked && <div role="status" className={styles.blocked}>Path blocked</div>}
    </div>
    <footer className={styles.footer}>
      <div className={styles.transport}>
        <button className={styles.icon} aria-label={playing ? "Pause journey" : "Play journey"} title={playing ? "Pause" : "Play journey"} disabled={!ready} onClick={() => {
          if (playing) setPlaying(false); else { if (time >= WORLD.duration || pose.label === "Explore") seek(0); setPlaying(true); }
        }}>{playing ? <Pause size={19} /> : <Play size={19} />}</button>
        <button className={styles.icon} title="Reset camera" aria-label="Reset camera" onClick={() => seek(0)}><SkipBack size={18} /></button>
        <input aria-label="Journey time" type="range" min={0} max={WORLD.duration} step="any" value={time} onChange={e => seek(Number(e.target.value))} />
        <output className={styles.time}>{time.toFixed(1)} / {WORLD.duration}s</output>
      </div>
      <div className={styles.details}>
        <select aria-label="Camera bookmark" value={BOOKMARKS.some(b => b.time === time) ? time : ""} onChange={e => seek(Number(e.target.value))}>
          <option value="" disabled>{pose.label}</option>{BOOKMARKS.map(b => <option key={b.time} value={b.time}>{b.label}</option>)}
        </select>
        <output aria-label="Camera position" className={styles.coordinates}>x {pose.position[0].toFixed(2)}<span>y {pose.position[1].toFixed(2)}</span>z {pose.position[2].toFixed(2)}</output>
        <span className={styles.sceneId}>aethelgard-quay / v1</span>
      </div>
    </footer>
  </main>;
}
