"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Crosshair, Download, RotateCcw, Save } from "lucide-react";
import { ankhStreetScene } from "@/lib/ankh-scene";
import { alignmentCamera, alignedDrumScene, alignmentPoints, alignmentResult, DRUM_ALIGNMENT, type AlignmentProfile } from "@/lib/drum-alignment";
import { DRUM_ENVIRONMENT } from "@/lib/drum-assets";
import { buildPlaceScene, disposePlace, OrbitControls, THREE } from "./place-scene-renderer";
import { applyRoofMaterials, applyStreetMaterials } from "./street-materials";
import { importDrumWorld, drumWorldEditorUrl } from "@/lib/drum-world-client";
import { batchStreetMeshes } from "./street-batching";
import s from "./drum-geometry.module.css";

export default function DrumGeometry() {
  const source = useMemo(() => ankhStreetScene(), []), host = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<AlignmentProfile>("shape_fit"), [textures, setTextures] = useState(true);
  const [saving, setSaving] = useState(false);
  const [overlay, setOverlay] = useState(0), [anchors, setAnchors] = useState(false), [travel, setTravel] = useState(0), [reset, setReset] = useState(0);
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [selected, setSelected] = useState("");
  const [teal, setTeal] = useState(false), [orbiting, setOrbiting] = useState(false);
  const runtime = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; scene: THREE.Scene; tavernId: string; invalidate: () => void } | null>(null);
  const points = useMemo(() => alignmentPoints(profile), [profile]), result = alignmentResult(profile);
  useEffect(() => {
    const container = host.current!, controller = new AbortController(); let frame = 0, materialsReady = false, dirty = true;
    setReady(false); setError(""); setSelected(""); setOrbiting(false);
    const aligned = alignedDrumScene(source, profile), built = buildPlaceScene(aligned.definition, { eaveHeights: aligned.eaveHeights });
    const camera = alignmentCamera(profile), renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(14));
    controls.minDistance = 3; controls.maxDistance = 50; controls.maxPolarAngle = Math.PI * 0.7;
    controls.enablePan = false;
    controls.addEventListener("change", () => { camera.position.y = Math.max(1.6, camera.position.y); dirty = true; });
    const onStart = () => { setOrbiting(true); setOverlay(0); setAnchors(false); };
    controls.addEventListener("start", onStart);
    const tavernId = source.objects.find(object => object.kind === "tavern")!.id;
    runtime.current = { camera, controls, scene: built.scene, tavernId, invalidate: () => { dirty = true; } };
    const observer = new ResizeObserver(() => { renderer.setSize(container.clientWidth, container.clientHeight); dirty = true; });
    observer.observe(container);
    const render = () => {
      if (materialsReady && dirty) { renderer.render(built.scene, camera); dirty = false; }
      container.dataset.camera = camera.position.toArray().map(value => value.toFixed(4)).join(",");
      frame = requestAnimationFrame(render);
    };
    render();
    const raycaster = new THREE.Raycaster();
    const pick = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), camera);
      const hit = raycaster.intersectObjects(built.scene.children, true).find(hit => hit.object.visible && hit.object.userData.objectId);
      setSelected(source.objects.find(object => object.id === hit?.object.userData.objectId)?.label || "");
    };
    renderer.domElement.addEventListener("pointerup", pick);
    (async () => {
      try {
        const count = textures ? await applyStreetMaterials(built.scene, controller.signal) : 0;
        if (!controller.signal.aborted) { applyRoofMaterials(built.scene, aligned.definition); container.dataset.batched = String(batchStreetMeshes(built.scene)); container.dataset.textured = String(count); materialsReady = true; setReady(true); }
      } catch { if (!controller.signal.aborted) setError("Material atlas could not be loaded"); }
    })();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener("pointerup", pick); disposePlace(built.scene); renderer.dispose(); renderer.domElement.remove(); runtime.current = null;
    };
  }, [source, profile, textures, reset]);
  useEffect(() => {
    const value = runtime.current; if (!value) return;
    const camera = alignmentCamera(profile);
    value.camera.position.copy(camera.position).add(new THREE.Vector3(-2 * travel / 100, 0, -0.6 * travel / 100));
    value.controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(14));
    value.controls.update();
  }, [profile, travel, textures, reset]);
  useEffect(() => {
    if (!ready || !runtime.current) return;
    const { scene, tavernId } = runtime.current;
    applyRoofMaterials(scene, { ...source, objects: source.objects.map(object => object.id === tavernId ? { ...object, roof_material: teal ? "teal" : "terracotta" } : object) });
    runtime.current.invalidate();
  }, [source, teal, ready, profile, textures, reset]);
  async function save() {
    setSaving(true); setError("");
    try {
      const world = await importDrumWorld();
      location.assign(`${drumWorldEditorUrl(world.source, world.place)}&template=drum&profile=${profile}&roof=${teal ? "teal" : "terracotta"}`);
    } catch (e) { setError((e as Error).message); setSaving(false); }
  }
  const calibrationVisible = travel === 0 && !orbiting;
  return <main className={s.page}>
    <header className={s.header}>
      <a href="/sketch/world/ankh" aria-label="Back to street" title="Back to street"><ArrowLeft size={18} /></a>
      <div className={s.title}><strong>The Mended Drum</strong><span>3D material &amp; alignment study</span></div>
      <label>Geometry<select aria-label="Geometry profile" value={profile} onChange={event => { setProfile(event.target.value as AlignmentProfile); setTravel(0); }}><option value="shape_fit">Roof + rear-depth fit</option><option value="vertical_only">Height fit</option><option value="original">Original</option><option value="free_camera">Camera fit (rejected)</option></select></label>
      <label className={s.check}><input type="checkbox" checked={textures} onChange={event => setTextures(event.target.checked)} />Textures</label>
      <a href="/demos/ankh-morpork/alignment-fit.json" download title="Download alignment receipt" aria-label="Download alignment receipt"><Download size={18} /></a>
      <button disabled={saving || profile === "free_camera"} onClick={() => void save()}><Save size={18} />{saving ? "Importing..." : "Save to world"}</button>
    </header>
    <section className={s.stage}>
      <div className={s.frame}>
        <div ref={host} className={s.canvas} data-testid="drum-geometry" data-ready={ready} data-profile={profile} data-roof={teal ? "teal" : "original"} />
        {/* eslint-disable-next-line @next/next/no-img-element -- alignment overlay must keep its exact pixels */}
        {calibrationVisible && <img className={s.reference} src={DRUM_ENVIRONMENT} alt="Street alignment reference" style={{ opacity: overlay / 100 }} />}
        {calibrationVisible && anchors && <svg className={s.anchors} viewBox={`0 0 ${DRUM_ALIGNMENT.observations.width} ${DRUM_ALIGNMENT.observations.height}`} aria-label="Landmark reprojection residuals">{points.map(point => <g key={point.id}><title>{point.label}: {point.error.toFixed(1)} px{point.fit ? "" : " (check)"}</title><line x1={point.pixel[0]} y1={point.pixel[1]} x2={point.projected[0]} y2={point.projected[1]} stroke="#ffdc50" strokeWidth="3" /><circle cx={point.pixel[0]} cy={point.pixel[1]} r="8" fill="none" stroke="#ffdc50" strokeWidth="3" /><circle cx={point.projected[0]} cy={point.projected[1]} r="5" fill="#51e4e7" /></g>)}</svg>}
        {error && <p className={s.error} role="alert">{error}</p>}
      </div>
    </section>
    <footer className={s.footer}>
      <div className={s.controls}>
        <label>Camera travel<input aria-label="Camera travel" type="range" min="0" max="100" value={travel} onChange={event => { setTravel(Number(event.target.value)); setOverlay(0); setAnchors(false); setOrbiting(false); }} /></label>
        <button title="Reset camera" aria-label="Reset camera" onClick={() => { setTravel(0); setReset(value => value + 1); }}><RotateCcw size={18} /></button>
        <label>Image overlay<input aria-label="Image overlay" type="range" min="0" max="100" value={overlay} disabled={!calibrationVisible} onChange={event => setOverlay(Number(event.target.value))} /></label>
        <button title="Alignment points" aria-label="Alignment points" disabled={!calibrationVisible} aria-pressed={anchors} onClick={() => setAnchors(value => !value)}><Crosshair size={18} /></button>
        <div role="group" aria-label="Roof material" className={s.swatches}><button aria-label="Terracotta roof" title="Terracotta roof" aria-pressed={!teal} onClick={() => setTeal(false)}><i style={{ background: "#9a5140" }} /></button><button aria-label="Teal roof" title="Teal roof" aria-pressed={teal} onClick={() => setTeal(true)}><i style={{ background: "#438780" }} /></button></div>
      </div>
      <div className={s.readout}><span>{selected || "Authored geometry / provisional fit"}</span><span>Fit RMS {result.fit_rms_px.toFixed(1)} px · Check RMS {result.held_out_rms_px.toFixed(1)} px</span><span>{profile === "free_camera" ? "Rejected: check error increases" : profile === "shape_fit" ? "Rear depth revised / front wall fixed" : "Ground footprints unchanged"}</span></div>
    </footer>
  </main>;
}
