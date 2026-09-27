"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import * as THREE from "three";
import { contract, makeLighthouse, placeCamera, type Mode } from "./world";
import styles from "./study.module.css";

export default function Study() {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("color");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const apply = useRef<(mode: Mode, offset: number) => void>(() => {});
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer | undefined;
    let world: ReturnType<typeof makeLighthouse> | undefined;
    let observer: ResizeObserver | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
      const canvas = renderer.domElement;
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Authored Crystal Lighthouse geometry");
      el.appendChild(canvas); world = makeLighthouse();
      const camera = new THREE.PerspectiveCamera(contract.camera.fov, 16 / 9, contract.camera.near, contract.camera.far);
      let currentMode: Mode = "color", currentOffset = 0;
      const render = () => {
        const width = el.clientWidth, height = el.clientHeight;
        if (!width || !height) return;
        renderer!.setSize(width, height); camera.aspect = width / height;
        camera.fov = camera.aspect < 1 ? 53 : contract.camera.fov;
        camera.updateProjectionMatrix(); placeCamera(camera, currentOffset); world!.setMode(currentMode);
        renderer!.render(world!.scene, camera);
        canvas.dataset.ready = "true"; canvas.dataset.mode = currentMode; canvas.dataset.offset = String(currentOffset);
        canvas.dataset.cameraHeight = String(camera.position.y);
      };
      apply.current = (nextMode, nextOffset) => { currentMode = nextMode; currentOffset = nextOffset; render(); };
      observer = new ResizeObserver(render); observer.observe(el); render();
    } catch (e) { setError(String(e)); }
    return () => { apply.current = () => {}; observer?.disconnect(); renderer?.dispose(); world?.dispose(); el.replaceChildren(); };
  }, []);
  useEffect(() => { apply.current(mode, offset); }, [mode, offset]);
  return <main className={styles.main}>
    <header className={styles.bar}>
      <div><h1>Crystal Lighthouse</h1><span>Authored geometry</span></div>
      <select aria-label="Guide mode" value={mode} onChange={e => setMode(e.target.value as Mode)}>
        <option value="color">Color</option><option value="clay">Clay</option><option value="depth">Depth</option>
      </select>
      <button title="Step left" aria-label="Step left" onClick={() => setOffset(n => Math.max(-4, n - 2))}><ArrowLeft size={18} /></button>
      <button title="Reset camera" aria-label="Reset camera" onClick={() => setOffset(0)}><RotateCcw size={18} /></button>
      <button title="Step right" aria-label="Step right" onClick={() => setOffset(n => Math.min(4, n + 2))}><ArrowRight size={18} /></button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className={styles.stage} ref={host} />
  </main>;
}
