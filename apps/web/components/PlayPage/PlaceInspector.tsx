"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Camera, Lock, Save, Search, X } from "lucide-react";
import type { EntityBBox, PlaceUpdate, WorldEntityGeo } from "@openflipbook/config";
import type { Page } from "@/lib/session-pages";
import { clamp } from "@/lib/clamp";
import { validReferenceBox } from "@/lib/place-identity";

interface Props {
  sessionId: string;
  places: WorldEntityGeo[];
  pages: Page[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpen: (id: string) => void;
  onEnter: (place: WorldEntityGeo, newView: boolean) => void;
  onSaved: () => Promise<void>;
  busy: boolean;
}

const WHOLE: EntityBBox = { x_pct: 0, y_pct: 0, w_pct: 1, h_pct: 1 };
const control = "w-full rounded border border-[var(--color-edge)] bg-transparent px-2 py-1.5 text-sm";

export default function PlaceInspector(props: Props) {
  const { onClose } = props;
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const place = props.places.find(p => p.id === props.selectedId);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside role="dialog" aria-label="Place inspector" aria-modal="false" className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[85dvh] flex-col rounded-t-lg border border-[var(--color-edge)] bg-[var(--color-canvas)] shadow-xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[384px] sm:rounded-none">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-edge)] px-4 py-3">
        <h2 className="font-display text-base">Places</h2>
        <button ref={closeRef} onClick={props.onClose} aria-label="Close place inspector" title="Close place inspector" className="grid h-8 w-8 place-items-center rounded hover:bg-black/10"><X size={18} /></button>
      </header>
      <div className="min-h-0 overflow-y-auto p-4">
        <label className="relative block"><Search size={16} className="absolute left-2 top-2" /><input aria-label="Search places" value={search} onChange={e => setSearch(e.target.value)} className={`${control} pl-8`} /></label>
        <nav aria-label="Places" className="my-3 max-h-36 overflow-y-auto border-b border-[var(--color-edge)] pb-2">
          {props.places.filter(p => p.label.toLowerCase().includes(search.toLowerCase())).map(p => (
            <button key={p.id} onClick={() => props.onSelect(p.id)} aria-pressed={p.id === place?.id} className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${p.id === place?.id ? "bg-emerald-600/15" : "hover:bg-black/5"}`}>
              <span className="min-w-0 flex-1 break-words">{p.label}</span>{p.identity_locked && <Lock size={13} aria-label="Identity locked" />}
            </button>
          ))}
          {!props.places.length && <p className="py-3 text-sm opacity-60">No mapped places</p>}
        </nav>
        {place && <PlaceDetails key={`${place.id}:${revision}`} {...props} place={place} onReload={async () => { await props.onSaved(); setRevision(v => v + 1); }} />}
      </div>
    </aside>
  );
}

function PlaceDetails({ place, onReload, ...props }: Props & { place: WorldEntityGeo; onReload: () => Promise<void> }) {
  const [label, setLabel] = useState(place.label);
  const [visual, setVisual] = useState(place.visual);
  const [locked, setLocked] = useState(place.identity_locked ?? false);
  const [sourceId, setSourceId] = useState(place.identity_anchor?.node_id ?? "");
  const [bbox, setBbox] = useState(place.identity_anchor?.bbox ?? WHOLE);
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const version = useRef(place.updated_at);
  const abort = useRef<AbortController | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const sources = props.pages.filter(p => p.nodeId && p.imageDataUrl);
  const source = sources.find(p => p.nodeId === sourceId);
  const endpoint = `/api/world/${encodeURIComponent(props.sessionId)}/places/${encodeURIComponent(place.id)}`;
  const image = sourceId === place.identity_anchor?.node_id ? `${endpoint}?v=${encodeURIComponent(place.updated_at)}` : source?.imageDataUrl;
  const views = sources.filter(p => p.sceneView?.focus_id === place.id);
  const parent = props.places.find(p => p.id === place.parent_id);
  const save = async () => {
    if (saving || (sourceId && !validReferenceBox(bbox))) return;
    const ac = new AbortController(); abort.current = ac;
    setSaving(true); setError(null); setSaved(false);
    const patch: PlaceUpdate = { expected_updated_at: version.current, label, visual, identity_locked: locked,
      ...(referenceDirty ? { reference: sourceId ? { node_id: sourceId, bbox } : null } : {}) };
    try {
      const res = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: ac.signal });
      const data = await res.json() as { place?: WorldEntityGeo; error?: string };
      if (!res.ok || !data.place) throw new Error(data.error ?? "Could not save place");
      version.current = data.place.updated_at;
      await props.onSaved();
      if (!ac.signal.aborted) { setReferenceDirty(false); setSaved(true); }
    } catch (e) { if (!ac.signal.aborted) setError((e as Error).message); }
    finally { if (!ac.signal.aborted) setSaving(false); }
  };
  return <section className="space-y-4">
    <div className="flex items-center gap-2 text-xs opacity-70"><span>{parent?.label ?? "World"}</span><ArrowRight size={12} /><span className="break-words">{place.label}</span></div>
    <label className="block text-xs">Name<input className={`${control} mt-1`} value={label} maxLength={160} onChange={e => { setLabel(e.target.value); setSaved(false); }} /></label>
    <label className="block text-xs">Appearance<textarea className={`${control} mt-1 min-h-20 resize-y`} value={visual} maxLength={2000} onChange={e => { setVisual(e.target.value); setSaved(false); }} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={locked} onChange={e => { setLocked(e.target.checked); setSaved(false); }} />Lock identity</label>
    <label className="block text-xs">Reference image<select aria-label="Reference image" className={`${control} mt-1`} value={sourceId} onChange={e => { setSourceId(e.target.value); setBbox(WHOLE); setReferenceDirty(true); setSaved(false); }}>
      <option value="">No reference</option>
      {place.identity_anchor && !sources.some(p => p.nodeId === place.identity_anchor?.node_id) && <option value={place.identity_anchor.node_id}>Saved reference</option>}
      {sources.map(p => <option key={p.nodeId} value={p.nodeId!}>{p.title}</option>)}
    </select></label>
    {image && <>
      <div className="relative touch-none overflow-hidden rounded border border-[var(--color-edge)]"
        onPointerDown={e => { const r = e.currentTarget.getBoundingClientRect(); dragStart.current = { x: clamp((e.clientX-r.left)/r.width, 0, 1), y: clamp((e.clientY-r.top)/r.height, 0, 1) }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { const start = dragStart.current; if (!start) return; const r = e.currentTarget.getBoundingClientRect(); const x = clamp((e.clientX-r.left)/r.width, 0, 1); const y = clamp((e.clientY-r.top)/r.height, 0, 1); const next = { x_pct: Math.min(x,start.x), y_pct: Math.min(y,start.y), w_pct: Math.abs(x-start.x), h_pct: Math.abs(y-start.y) }; if (next.w_pct > .01 && next.h_pct > .01) { setBbox(next); setReferenceDirty(true); setSaved(false); } }}
        onPointerUp={() => { dragStart.current = null; }} onPointerCancel={() => { dragStart.current = null; }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- persisted world image */}
        <img src={image} alt="Place reference" draggable={false} className="block h-auto w-full" />
        <div className="pointer-events-none absolute border-2 border-emerald-500" style={{ left: `${bbox.x_pct*100}%`, top: `${bbox.y_pct*100}%`, width: `${bbox.w_pct*100}%`, height: `${bbox.h_pct*100}%`, boxShadow: "0 0 0 999px #0006" }} />
      </div>
      <div className="grid grid-cols-4 gap-2">{([['x_pct','Left'],['y_pct','Top'],['w_pct','Width'],['h_pct','Height']] as const).map(([key,text]) => <label key={key} className="text-xs">{text} %<input aria-label={`Reference ${text.toLowerCase()} percent`} className={`${control} mt-1 px-1`} type="number" min={0} max={100} step={1} value={Math.round(bbox[key]*100)} onChange={e => { setBbox(b => ({ ...b, [key]: Number(e.target.value)/100 })); setReferenceDirty(true); setSaved(false); }} /></label>)}</div>
    </>}
    {error && <div role="alert" className="text-sm text-red-600"><p>{error}</p><button disabled={saving} onClick={() => { setSaving(true); void onReload().catch(e => { setError((e as Error).message); setSaving(false); }); }} className="mt-1 underline">Reload place</button></div>}
    <div className="flex items-center gap-2"><button title="Save place" aria-label="Save place" disabled={saving || !label.trim() || !!sourceId && !validReferenceBox(bbox)} onClick={() => void save()} className="flex h-9 items-center gap-2 rounded bg-emerald-700 px-3 text-sm text-white disabled:opacity-50"><Save size={16} />{saving ? "Saving" : "Save"}</button>{saved && <span role="status" className="text-xs">Saved</span>}</div>
    <div className="flex flex-wrap gap-2 border-t border-[var(--color-edge)] pt-4"><button disabled={props.busy || saving} onClick={() => props.onEnter(place, false)} className="flex items-center gap-2 rounded border border-[var(--color-edge)] px-3 py-2 text-sm"><ArrowRight size={16} />Enter</button><button disabled={props.busy || saving} onClick={() => props.onEnter(place, true)} className="flex items-center gap-2 rounded border border-[var(--color-edge)] px-3 py-2 text-sm"><Camera size={16} />New view</button></div>
    <h3 className="text-sm font-medium">Saved views</h3>
    {views.length === 0 && <p className="text-sm opacity-60">No saved views</p>}
    <div className="grid grid-cols-2 gap-2">{views.map(p => <button key={p.nodeId} title={`Open saved view: ${p.title}`} onClick={() => props.onOpen(p.nodeId!)} className="overflow-hidden rounded border border-[var(--color-edge)] text-left">
      {/* eslint-disable-next-line @next/next/no-img-element -- persisted world image */}
      <img src={p.imageDataUrl!} alt="" className="aspect-video w-full object-cover" /><span className="block truncate p-2 text-xs">{p.title}</span>
    </button>)}</div>
  </section>;
}
