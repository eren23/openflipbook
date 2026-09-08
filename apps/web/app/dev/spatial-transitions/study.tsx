"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Play, RotateCcw } from "lucide-react";
import { SpatialTransitionLayer } from "@/components/SpatialTransitionLayer";
import { useSpatialNavigation, decodeSpatialImage } from "@/hooks/useSpatialNavigation";
import { planSpatialTransition, type ReframePlan, type SpatialFrame } from "@/lib/spatial-transition";
import { SPATIAL_STUDY_CASES } from "@/lib/spatial-study";

const asset = (name: string) => `/api/dev/spatial-assets/${name}`;

export default function SpatialStudy() {
  const [selection, setSelection] = useState(0);
  const [scene, setScene] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [controlImage, setControlImage] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1600, height: 900 });
  const h3 = useRef<HTMLVideoElement>(null);
  const ltx = useRef<HTMLVideoElement>(null);
  const player = useSpatialNavigation();
  const fixture = SPATIAL_STUDY_CASES[selection]!;
  const source: SpatialFrame = { id: "source", parentId: null, image: asset(scene ? `${fixture.id}-destination.jpg` : fixture.source), view: { node_id: "source", level: scene ? "eye" : "map", observer: null, map_crop: null } };
  const destination: SpatialFrame = { id: "destination", parentId: "source", image: scene ? controlImage ?? source.image : asset(`${fixture.id}-destination.jpg`), click: { x_pct: scene ? [.15, .5, .85][selection]! : fixture.x, y_pct: scene ? .55 : fixture.y } };
  const plan = planSpatialTransition(source, destination) as ReframePlan;
  const reset = () => { player.cancel(); setArrived(false); setScrub(null); h3.current?.pause(); ltx.current?.pause(); };
  const play = async (back = false) => {
    setScrub(null);
    let target = destination;
    if (scene && !controlImage) {
      const image = await decodeSpatialImage(source.image);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext("2d")!.drawImage(image, plan.crop.x * canvas.width, plan.crop.y * canvas.height, plan.fraction * canvas.width, plan.fraction * canvas.height, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/png"); setControlImage(url); target = { ...destination, image: url };
    }
    if (!back && !scene) for (const video of [h3.current, ltx.current]) if (video) { video.currentTime = 0; void video.play().catch(() => {}); }
    await player.navigate(back ? target : source, back ? source : target, () => setArrived(!back));
  };
  const motion = scrub === null ? player.motion : { plan, progress: scrub, ...dimensions };
  return <main style={{ maxWidth: 1500, margin: "auto", padding: 24 }}>
    <h1 style={{ fontSize: 24 }}>Spatial Transition Study</h1>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, margin: "20px 0" }}>
      <select aria-label="Fixture" value={selection} onChange={e => { reset(); setSelection(Number(e.target.value)); setControlImage(null); }}>
        {SPATIAL_STUDY_CASES.map((c, i) => <option key={c.id} value={i}>{c.title}</option>)}
      </select>
      <label><input type="checkbox" checked={scene} onChange={e => { reset(); setScene(e.target.checked); setControlImage(null); }} /> Scene control</label>
      <button title="Play" aria-label="Play" onClick={() => { reset(); void play(); }}><Play size={20} /></button>
      <button title="Back" aria-label="Back" disabled={!arrived || player.pending} onClick={() => void play(true)}><ArrowLeft size={20} /></button>
      <button title="Reset" aria-label="Reset" onClick={reset}><RotateCcw size={20} /></button>
      <input aria-label="Reframe progress" type="range" min={0} max={1} step={.01} value={scrub ?? player.motion?.progress ?? 0} onChange={e => { player.cancel(); setArrived(false); setScrub(Number(e.target.value)); }} />
    </div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <section>
        <h2 style={{ fontSize: 16 }}>Source pixels</h2>
        <div data-testid="study-stage" style={{ position: "relative", aspectRatio: "16/9", background: "#111", overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- exact study fixture */}
          <img data-testid="study-image" alt={arrived ? "Destination" : "Source"} src={arrived ? destination.image : source.image} style={{ width: "100%", height: "100%", objectFit: "contain" }} onLoad={e => { if (!arrived) setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); }} />
          <SpatialTransitionLayer motion={motion} background="#111" />
        </div>
        <p>Target: {plan.target.x_pct.toFixed(3)}, {plan.target.y_pct.toFixed(3)}</p>
        <p>Motion: {scene ? "1.35x / 450 ms" : "2.38x / 800 ms"}. Cut: {arrived ? "arrived" : "pending"}.</p>
      </section>
      {!scene && <>{[["H3 (saved)", fixture.h3, h3], ["LTX (saved)", fixture.ltx, ltx]].map(([label, file, ref]) => <section key={String(label)}>
        <h2 style={{ fontSize: 16 }}>{String(label)}</h2>
        <video ref={ref as typeof h3} key={String(file)} src={asset(String(file))} controls muted playsInline preload="metadata" style={{ width: "100%", aspectRatio: "16/9", background: "#111", objectFit: "contain" }} />
      </section>)}</>}
    </div>
    <p>Destination identity: {scene ? "same-image crop control" : `FAIL: target is ${fixture.title}; supplied destination is ${fixture.destination}`}.</p>
    <p>Perceptual continuity: not yet human-rated.</p>
    {player.error && <button onClick={() => void player.retry()}>{player.error}</button>}
  </main>;
}
