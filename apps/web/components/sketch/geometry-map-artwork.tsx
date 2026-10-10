"use client";
import { useRef, useState } from "react";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView } from "@/lib/place-view";
import PlaceIllustrations from "./place-illustrations";
import { captureGeometryMap } from "./geometry-map-capture";
import { worldEditorHref, worldEditorSelection } from "@/lib/world-editor-selection";
import s from "./world-editor.module.css";

export interface GeometryMapContext { kind: "geometry_derived"; scene: PlaceSceneSnapshot; views: SavedPlaceView[] }
async function request(url: string, body?: unknown) {
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Map artwork unavailable"); return result;
}
export default function GeometryMapArtwork({ initial }: { initial: GeometryMapContext }) {
  const [context, setContext] = useState(initial), [chosen, setChosen] = useState(initial.views[0]?.id ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState(() => worldEditorSelection(initial.scene.definition, typeof window === "undefined" ? null : new URLSearchParams(location.search).get("object"), null).object_id);
  const pending = useRef<Record<string, unknown> | null>(null), { session_id: sid, place_id: pid } = context.scene;
  const endpoint = `/api/world/${encodeURIComponent(sid)}/places/${encodeURIComponent(pid)}`, view = context.views.find(v => v.id === chosen);
  function select(id: string) { setSelected(id); window.history.replaceState(null, "", worldEditorHref(context.scene, { object_id: id, floor_id: null }, { map: true })); }
  async function capture() {
    setBusy(true); setError("");
    try {
      if (!pending.current) {
        const fresh: GeometryMapContext = await request(`${endpoint}/map-artwork`); setContext(fresh);
        const saved = fresh.views.find(v => v.id === chosen), previous = saved?.historical ? saved : undefined;
        const captured = await captureGeometryMap(fresh.scene, { mesh: `/api/world/${sid}/meshes`, material: `/api/world/${sid}/materials` }, new AbortController().signal, previous);
        pending.current = { id: crypto.randomUUID(), label: `Map artwork / r${fresh.scene.revision}`, capture: captured, ...(previous ? { refreshed_from: previous.id } : {}) };
      }
      const result = await request(`${endpoint}/derived-map`, pending.current);
      pending.current = null; setContext(await request(`${endpoint}/map-artwork`)); setChosen(result.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className={s.editor}>
    <header className={s.header}><a href={worldEditorHref(context.scene, { object_id: selected, floor_id: null }, { view: "plan" })}>World</a><strong>Map artwork</strong><span className={s.status}>Geometry r{context.scene.revision}</span></header>
    {error && <div className={s.error} role="alert">{error}</div>}
    <div className={s.body}><section className={s.stage} aria-label="Geometry-derived map artwork"><div ref={setSurface} style={{ width: "100%", height: "100%", position: "relative" }}/></section><aside className={s.inspector}>
      <p>Map artwork uses the saved world’s exterior geometry and an exact overhead camera.</p>
      <label>Object<select aria-label="Selected world object" value={selected ?? ""} disabled={busy || !!pending.current} onChange={e => select(e.target.value)}><option value="">No object selected</option>{context.scene.definition.objects.filter(o => !o.placement).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
      {selected && <a href={worldEditorHref(context.scene, { object_id: selected, floor_id: null }, { view: "orbit" })}>Open selected object in 3D</a>}
      {!!context.views.length && <label>Saved map<select aria-label="Saved map camera" value={chosen} disabled={busy || !!pending.current} onChange={e => setChosen(e.target.value)}>{context.views.map(v => <option key={v.id} value={v.id}>{v.label}{v.historical ? " / historical" : ""}</option>)}</select></label>}
      <button disabled={busy} onClick={() => void capture()}>{busy ? "Saving map camera…" : pending.current ? "Retry saving map camera" : view?.historical ? "Refresh saved map camera" : "Capture map camera"}</button>
      {view && <PlaceIllustrations key={view.id} sessionId={sid} view={view} previousView={view.refreshed_from ? context.views.find(v => v.id === view.refreshed_from) : undefined} disabled={busy || !!pending.current} surfaceTarget={surface} selectedObject={selected} onSelectObject={select}/>}
    </aside></div>
  </main>;
}
