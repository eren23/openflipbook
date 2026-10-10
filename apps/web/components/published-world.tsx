"use client";
import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import type { PublicationCapture, WorldPublication } from "@/lib/world-publication";
import { publicationPlaceNetwork } from "@/lib/world-publication-geometry";
import s from "./published-world.module.css";
const PlaceViewport = dynamic(() => import("./sketch/place-viewport"), { ssr: false });
function CaptureRevision({ capture, world }: { capture: PublicationCapture | undefined; world: WorldPublication }) {
  return <p className={s.capture}>{capture ? <>{capture.historical ? "Historical capture geometry" : "Capture matches published geometry"} · {capture.sources.map(source =>
    `${world.scenes.find(scene => scene.place_id === source.place_id)?.definition.label ?? source.place_id} revision ${source.revision}`).join(", ")}</>
    : "Capture revision unavailable in this legacy snapshot"}</p>;
}
export default function PublishedWorld({ world, privateSession }: { world: WorldPublication; privateSession?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const request = useRef<string | null>(null);
  const [place, setPlace] = useState(world.scenes[0]!.place_id), [mode, setMode] = useState<"plan" | "orbit" | "walk">("orbit");
  const [walkingPlace, setWalkingPlace] = useState<string | null>(null);
  const network = useMemo(() => publicationPlaceNetwork(world, place), [world, place]);
  const scene = world.scenes.find(x => x.place_id === place)!;
  const switchMode = (next: typeof mode) => {
    if (mode === "walk" && walkingPlace && next !== "walk") setPlace(walkingPlace);
    setWalkingPlace(null); setMode(next);
  };
  const file = (id: string) => privateSession ? `/api/world/${privateSession}/publication-files/${id}` : `/api/publications/${world.id}/files/${id}`;
  const fork = async () => { if (busy) return; setBusy(true); setError(""); request.current ??= crypto.randomUUID(); try {
    const res = await fetch(`/api/publications/${world.id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: request.current }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Fork unavailable"); window.location.href = `/sketch/world?world=${encodeURIComponent(data.session_id)}&place=${encodeURIComponent(place)}`;
  } catch (e) { setError(e instanceof Error ? e.message : "Fork unavailable"); setBusy(false); } };
  return <main className={s.page}>
    <header className={s.header}><a className={s.back} href="/gallery">← Gallery</a><h1>{world.title}</h1><p className={s.meta}>Published snapshot · {new Date(world.created_at).toLocaleDateString()}</p>
      <div className={s.actions}>{privateSession ? <a href={`/sketch/world?world=${privateSession}&place=${place}`}>Open editable workspace</a> : <><button disabled={busy} onClick={() => void fork()}>Fork selected content</button><a href={`/api/publications/${world.id}/export`}>Download snapshot</a></>}</div>
      {error && <p role="alert" className={s.error}>{error}</p>}
    </header>
    <section className={s.geometry} aria-label="Published geometry">
      <div className={s.controls}>
        <label>Place <select value={place} onChange={e => { setWalkingPlace(null); setPlace(e.target.value); }}>{world.scenes.map(x => <option key={x.place_id} value={x.place_id}>{x.definition.label}</option>)}</select></label>
        <label>View <select value={mode} onChange={e => switchMode(e.target.value as typeof mode)}><option value="plan">Plan</option><option value="orbit">3D</option><option value="walk">Walk</option></select></label>
      </div>
      {network && <p className={s.network} role="status">Walk through {network.chunks.length} connected places{mode === "walk" && walkingPlace ? ` · ${world.scenes.find(x => x.place_id === walkingPlace)?.definition.label ?? scene.definition.label}` : ""}</p>}
      <div className={s.viewer}><PlaceViewport definition={scene.definition} mode={mode} onSelect={() => {}} network={network} placeId={place} onPlaceChange={setWalkingPlace} assetBaseUrl={privateSession ? `/api/world/${privateSession}/meshes` : `/api/publications/${world.id}/meshes`} materialBaseUrl={privateSession ? `/api/world/${privateSession}/materials` : `/api/publications/${world.id}/materials`} /></div>
    </section>
    {world.views.map(x => <figure className={s.media} key={x.id}><figcaption>{x.label}</figcaption>
      <CaptureRevision capture={x.capture} world={world}/>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={file(x.file_id)} alt={x.label} /></figure>)}
    {world.videos.map(x => <figure className={s.media} key={x.id}><figcaption>{x.label} · ready for review</figcaption><CaptureRevision capture={x.capture} world={world}/><video src={file(x.file_id)} controls playsInline preload="metadata" /></figure>)}
  </main>;
}
