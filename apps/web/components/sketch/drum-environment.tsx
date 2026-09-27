"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Box, Compass, Crosshair, Map, MapPin, Paintbrush, RotateCcw, Save, ZoomIn } from "lucide-react";
import { ankhStreetScene, ANKH_MAP, DRUM_MAP_ANCHOR } from "@/lib/ankh-scene";
import { environmentCamera } from "@/lib/drum-environment";
import { DRUM_ENVIRONMENT, DRUM_EDIT } from "@/lib/drum-assets";
import { buildPlaceScene, disposePlace, THREE } from "./place-scene-renderer";
import { importDrumWorld, drumWorldEditorUrl } from "@/lib/drum-world-client";
import s from "./drum-environment.module.css";

function GeometryGuide() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current!;
    const { scene } = buildPlaceScene(ankhStreetScene());
    const camera = environmentCamera();
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(1600, 900); renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement); renderer.render(scene, camera); container.dataset.ready = "true";
    return () => { disposePlace(scene); renderer.dispose(); renderer.domElement.remove(); };
  }, []);
  return <div ref={host} data-testid="environment-guide" style={{ width: 1600, height: 900 }} />;
}

export default function DrumEnvironment() {
  const [capture, setCapture] = useState(false), [view, setView] = useState<"map" | "street">("map");
  const [focused, setFocused] = useState(false), [hotspots, setHotspots] = useState(false), [selected, setSelected] = useState("");
  const [edited, setEdited] = useState(false);
  const [saved, setSaved] = useState<{ session_id: string; place_id: string; parent_source_url: string | null; map_artworks?: { id: string; title: string; url: string }[]; versions: { id: string; title: string; url: string }[]; scene: { revision: number; definition: { material_pack?: string } } | null } | null>(null);
  const [mapVersion, setMapVersion] = useState("");
  const [current, setCurrent] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(location.search), controller = new AbortController();
    setCapture(query.get("capture") === "1");
    if (query.get("source")) {
      setBusy(true); setCurrent(query.get("source")!); setView(query.get("view") === "map" ? "map" : "street");
      void fetch(`/api/world/scene-context?${query}`, { cache: "no-store", signal: controller.signal }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load the place");
        if (data.scene?.definition.material_pack !== "ankh-street-v1") throw new Error("This image has no saved Drum scene. Open it in World editor first.");
        setSaved(data);
      }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }
    return () => controller.abort();
  }, []);
  async function save() {
    setBusy(true); setError("");
    try { const world = await importDrumWorld(); location.assign(`${drumWorldEditorUrl(world.source, world.place)}&template=drum&roof=${edited ? "teal" : "terracotta"}`); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  if (capture) return <GeometryGuide />;
  const imageUrl = saved ? view === "map" ? saved.map_artworks?.find(v => v.id === mapVersion)?.url ?? saved.parent_source_url : saved.versions.find(v => v.id === current)?.url : view === "map" ? ANKH_MAP : edited ? DRUM_EDIT : DRUM_ENVIRONMENT;
  if (current && !saved) return <main className={s.page}><p role={error ? "alert" : "status"}>{error || "Loading saved place..."}</p><a href={drumWorldEditorUrl(current)}>World editor</a></main>;
  return <main className={s.page}>
    <header className={s.header}>
      <a href={saved ? `/sketch?source=${encodeURIComponent(current)}` : "/sketch"} title="Back to Sketch" aria-label="Back to Sketch"><ArrowLeft size={18} /></a>
      <div className={s.title}><strong>{view === "map" ? "Ankh-Morpork" : "The Mended Drum"}</strong><span>{view === "map" ? "The Great Wahoonie" : "Filigree Street"}</span></div>
      <nav aria-label="Environment view"><button aria-pressed={view === "map"} onClick={() => { setView("map"); setSelected(""); }}><Map size={17} />Map</button><button aria-pressed={view === "street"} onClick={() => setView("street")}><MapPin size={17} />Street</button></nav>
      {saved && <a title="Explore world" aria-label="Explore world" href={`/play?continue=${encodeURIComponent(saved.session_id)}&node=${encodeURIComponent(view === "map" ? mapVersion || saved.map_artworks?.find(v => v.url === saved.parent_source_url)?.id || current : current)}`}><Compass size={18} /></a>}
      <a href={saved ? drumWorldEditorUrl(current, saved.place_id) : "/sketch/world/ankh/geometry"} title="3D materials and alignment" aria-label="3D materials and alignment"><Box size={18} /></a>
      {!saved && <button disabled={busy} onClick={() => void save()}><Save size={18} />{busy ? "Importing..." : "Save to world"}</button>}
    </header>
    <section className={s.stage} aria-label="Environment">
      <div className={s.frame}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static demo artwork shown at its exact pixels */}
        {imageUrl ? <img key={view} className={s.artwork} src={imageUrl} alt={view === "map" ? "Ankh-Morpork city map" : !saved && edited ? "The Mended Drum with its saved teal roof edit" : "The Mended Drum on Filigree Street"} style={view === "map" ? { transform: focused ? "scale(4)" : "scale(1)", transformOrigin: `${DRUM_MAP_ANCHOR.x}% ${DRUM_MAP_ANCHOR.y}%` } : { transition: "none" }} /> : <p>No parent map is saved for this image.</p>}
        {error && <p role="alert">{error}</p>}
        {!saved && view === "street" && hotspots && ([
          ["Drum roof", 45, 16], ["Front door", 57, 59], ["Barrels", 43, 68], ["Well", 12, 87],
        ] as const).map(([label, x, y]) => <button key={label} className={s.hotspot} style={{ left: `${x}%`, top: `${y}%` }} title={label} aria-label={label} onClick={() => setSelected(label)}><Crosshair size={20} /></button>)}
        {view === "map" && <div className={s.mapActions}><button title={focused ? "Show whole map" : "Focus Mended Drum"} aria-label={focused ? "Show whole map" : "Focus Mended Drum"} onClick={() => setFocused(v => !v)}>{focused ? <RotateCcw size={18} /> : <ZoomIn size={18} />}</button><button onClick={() => setView("street")}><MapPin size={17} />Enter the Drum's street</button></div>}
      </div>
    </section>
    <footer className={s.footer}>
      <span>{view === "map" ? "Ankh-Morpork / Morpork / Filigree Street" : saved ? `Geometry r${saved.scene?.revision} / image alignment unverified` : selected || "Mended Drum exterior"}</span>
      {view === "map" && saved && <><label>Map artwork<select aria-label="Map artwork version" value={mapVersion || saved.map_artworks?.find(v => v.url === saved.parent_source_url)?.id || ""} onChange={e => setMapVersion(e.target.value)}>{saved.map_artworks?.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label><a className={s.edit} href={`/sketch/world/map?source=${encodeURIComponent(current)}`}><Paintbrush size={17} />Repaint map</a></>}
      {view === "street" && <>{saved ? <label>Image version<select aria-label="Image version" value={current} onChange={e => { setCurrent(e.target.value); history.replaceState(null, "", `?source=${encodeURIComponent(e.target.value)}&place=${encodeURIComponent(saved.place_id)}`); }}>{saved.versions.map((v, i) => <option key={v.id} value={v.id}>{i + 1}. {v.title}</option>)}</select></label> : <><div className={s.versions} role="group" aria-label="Saved roof versions"><button aria-pressed={!edited} onClick={() => setEdited(false)}><span className={s.swatch} style={{ background: "#8a4939" }} />Original</button><button aria-pressed={edited} onClick={() => setEdited(true)}><span className={s.swatch} style={{ background: "#3d6461" }} />Teal roof</button></div><button title="Inspect landmarks" aria-label="Inspect landmarks" aria-pressed={hotspots} onClick={() => setHotspots(v => !v)}><Crosshair size={18} /></button></>}<a className={s.edit} href={saved ? `/sketch?source=${encodeURIComponent(current)}` : `/sketch?example=${edited ? "drum-teal" : "drum"}`}><Paintbrush size={17} />Edit in Sketch</a></>}
    </footer>
  </main>;
}
