"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { Camera, Focus, Image as ImageIcon, RefreshCw, Route } from "lucide-react";
import { VIEW_PASSES, type SavedPlaceView, type ViewCapture, type ViewPass, type RefreshPlaceView } from "@/lib/place-view";
import s from "./world-editor.module.css";
import PlaceIllustrations from "./place-illustrations";
import PlaceCameraMotion, { type CaptureMotion } from "./place-camera-motion";

export default function PlaceViewLibrary({ sessionId, placeId, revision, capture, refreshView, disabled, onLoadPath, surfaceTarget, onOpenIllustration, selectedObject, onSelectObject, captureMotion, onSelectedViewChange, onComposeSelection, selectedObjectLabel }: {
  sessionId: string; placeId: string; revision: number; capture: (() => ViewCapture) | null; disabled: boolean;
  onLoadPath?: ((view: SavedPlaceView) => void) | undefined;
  refreshView?: RefreshPlaceView | null;
  captureMotion?: CaptureMotion | undefined;
  surfaceTarget?: HTMLElement | null | undefined; onOpenIllustration?: (() => void) | undefined;
  selectedObject?: string | null | undefined; onSelectObject?: ((id: string) => void) | undefined;
  onSelectedViewChange?: ((id: string | null) => void) | undefined;
  onComposeSelection?: (() => void) | undefined; selectedObjectLabel?: string | undefined;
}) {
  const [views, setViews] = useState<SavedPlaceView[]>([]), [selected, setSelected] = useState(() => typeof window !== "undefined" && onOpenIllustration ? new URLSearchParams(window.location.search).get("camera") ?? "" : "");
  const [label, setLabel] = useState("Camera view"), [pass, setPass] = useState<ViewPass>("render");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [imageError, setImageError] = useState(false);
  const [illustrationPending, setIllustrationPending] = useState(false);
  const pending = useRef<{ id: string; label: string; capture: ViewCapture; refreshed_from?: string } | null>(null);
  const saving = useRef(false), mounted = useRef(true);
  const openAfterSave = useRef(false);
  const reads = useRef({ version: 0 });
  const live = useRef({ disabled, revision, selected }); live.current = { disabled, revision, selected };
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(placeId)}/views`;
  const reload = useCallback(async () => {
    const read = ++reads.current.version;
    const response = await fetch(endpoint, { cache: "no-store" }), data = await response.json();
    if (read !== reads.current.version) return;
    if (!response.ok) throw new Error(data.error || "Saved views are unavailable");
    setViews(data.views); setSelected(old => data.views.some((v: SavedPlaceView) => v.id === old) ? old : data.views[0]?.id ?? "");
  }, [endpoint]);
  useEffect(() => { const state = reads.current; let active = true; mounted.current = true; void reload().catch(e => { if (active) setError(e.message); }); return () => { active = false; mounted.current = false; state.version++; }; }, [reload, revision]);
  useEffect(() => { setImageError(false); }, [selected, pass]);
  useEffect(() => { onSelectedViewChange?.(selected || null); }, [selected, onSelectedViewChange]);
  useEffect(() => {
    if (!selected || !onOpenIllustration) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("world") !== sessionId || url.searchParams.get("place") !== placeId) return;
    url.searchParams.set("camera", selected); window.history.replaceState(null, "", url);
  }, [selected, onOpenIllustration, sessionId, placeId]);
  async function save(source?: SavedPlaceView, openIllustration = false) {
    if (saving.current || busy || illustrationPending || !pending.current && (disabled || (source ? !refreshView : !capture))) return;
    saving.current = true;
    reads.current.version++;
    setBusy(true); setError("");
    try {
      if (!pending.current) {
        openAfterSave.current = openIllustration;
        const captured = source ? await refreshView!(source) : capture!();
        if (!mounted.current || live.current.disabled || live.current.revision !== revision) throw new Error("Scene changed while capturing. Refresh again.");
        pending.current = { id: crypto.randomUUID(), label: source?.label ?? label, capture: captured, ...(source ? { refreshed_from: source.id } : {}) };
      }
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.current) });
      const data = await response.json();
      if (!response.ok) { if ([400, 403, 404, 409, 413].includes(response.status)) pending.current = null; throw new Error(data.error || "View could not be saved"); }
      await reload();
      pending.current = null;
      if (mounted.current) { setSelected(data.id); setPass("render"); if (openAfterSave.current) onOpenIllustration?.(); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  const view = views.find(v => v.id === selected);
  async function loadPath() {
    if (busy || disabled || !view?.path || !onLoadPath) return;
    const read = ++reads.current.version, id = view.id;
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { cache: "no-store" }), data = await response.json();
      if (read !== reads.current.version || live.current.disabled || live.current.revision !== revision || live.current.selected !== id) return;
      if (!response.ok) throw new Error(data.error || "Saved path is unavailable");
      setViews(data.views);
      const fresh = data.views.find((v: SavedPlaceView) => v.id === id);
      if (!fresh?.path || fresh.historical) throw new Error("Saved path geometry is no longer current");
      onLoadPath(fresh);
    } catch (e) { if (read === reads.current.version) setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className={s.meshGenerator} aria-label="Saved camera views">
    <div className={s.sectionHeading}><h2><Camera size={16}/>Camera views</h2><button aria-label="Refresh saved camera views" title="Refresh saved camera views" disabled={busy} onClick={() => void reload().catch(e => setError(e.message))}><RefreshCw size={16}/></button></div>
    {onComposeSelection && <button disabled={disabled || busy || illustrationPending || !!pending.current || !selectedObject} title={selectedObjectLabel ? `Compose ${selectedObjectLabel}` : "Select an object first"} onClick={() => { setLabel(`${selectedObjectLabel || "Selected object"} / close-up`.slice(0, 120)); onComposeSelection(); }}><Focus size={16}/>Compose selected object</button>}
    {(!surfaceTarget || pending.current) && <><label>View name<input aria-label="View name" maxLength={120} value={label} disabled={busy || !!pending.current} onChange={e => setLabel(e.target.value)}/></label>
    <button disabled={busy || illustrationPending || !!pending.current?.refreshed_from || !pending.current && (disabled || !label.trim() || !capture)} title={disabled ? "Save scene changes before capturing" : "Save camera render and geometry passes"} onClick={() => void save()}><Camera size={16}/>{pending.current && !pending.current.refreshed_from ? "Retry saved view request" : "Save camera view"}</button></>}
    {!surfaceTarget && onOpenIllustration && !pending.current && <button disabled={busy || illustrationPending || disabled || !label.trim() || !capture} onClick={() => void save(undefined, true)}><ImageIcon size={16}/>Save view and open illustration</button>}
    {!!views.length && <label>Saved view<select aria-label="Saved camera view" value={selected} disabled={busy || !!pending.current || illustrationPending} onChange={e => setSelected(e.target.value)}>{views.map(v => <option key={v.id} value={v.id}>{v.label}{v.refreshed_from ? " / refreshed" : ""}{v.historical ? " / historical" : ""}</option>)}</select></label>}
    {views.some(v => v.historical) && <p className={s.meshMeta}>{views.filter(v => v.historical).length} historical views</p>}
    {(view?.historical || pending.current?.refreshed_from) && <button disabled={busy || illustrationPending || !pending.current && (disabled || !refreshView) || !!pending.current && !pending.current.refreshed_from} onClick={() => void save(view)}><RefreshCw size={16}/>{pending.current?.refreshed_from ? "Retry view refresh request" : "Refresh saved view geometry"}</button>}
    {view && <>
      <p role="status" className={s.meshMeta}>{view.historical ? "Historical geometry" : "Current geometry"} / {view.mode} / {view.width} x {view.height}</p>
      {surfaceTarget && createPortal(<div className={s.illustrationCaption} title={`${view.label} / ${view.historical ? "Historical geometry" : "Current geometry"} / ${view.mode}`}>{view.label} / {view.historical ? "Historical geometry" : "Current geometry"} / {view.mode}</div>, surfaceTarget)}
      {onOpenIllustration && !surfaceTarget && <button onClick={onOpenIllustration}><ImageIcon size={16}/>Open illustration</button>}
      {view.refreshed_from && views.some(v => v.id === view.refreshed_from) && <button disabled={busy || !!pending.current || illustrationPending} onClick={() => setSelected(view.refreshed_from!)}>Previous view</button>}
      {view.path && <><p className={s.meshMeta}>{view.path.keyframes.length} keyframes / {view.path.duration}s</p><button disabled={busy || disabled || view.historical || !onLoadPath} onClick={() => void loadPath()}><Route size={16}/>Load camera path</button></>}
      {view.path && captureMotion && <PlaceCameraMotion key={`motion:${sessionId}:${view.id}`} sessionId={sessionId} view={view} disabled={disabled || busy || illustrationPending || !!pending.current} captureMotion={captureMotion}/>}
      <details className={s.geometryPasses} open={!surfaceTarget ? true : undefined}><summary>Geometry passes</summary>
      <div className={s.viewPasses} role="group" aria-label="Saved view pass">{VIEW_PASSES.map(p => <button key={p} aria-pressed={pass === p} onClick={() => setPass(p)}>{p[0]!.toUpperCase() + p.slice(1)}</button>)}</div>
      <Image unoptimized src={`/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/${pass}`} alt={`${view.label} ${pass} pass`} width={view.width} height={view.height} style={{ width: "100%", height: "auto" }} onError={() => setImageError(true)}/>
      {imageError && <p role="alert">Saved view image is unavailable.</p>}
      </details>
      <PlaceIllustrations key={`${sessionId}:${view.id}`} sessionId={sessionId} view={view} previousView={views.find(v => v.id === view.refreshed_from)} disabled={disabled} surfaceTarget={surfaceTarget} selectedObject={selectedObject} onSelectObject={onSelectObject} onPendingChange={setIllustrationPending}/>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
