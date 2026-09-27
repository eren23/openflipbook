"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Eye, Paintbrush, Focus, Crosshair, Save, Trash2, Scan, Move, Check, X, RefreshCw } from "lucide-react";
import type { PlaceSceneSnapshot, WorldEditProposal } from "@openflipbook/config";
import { mapChanges, mapObject, mapRepaintState, type MapRegistration } from "@/lib/map-artwork";
import { worldEditorSelection, worldEditorHref, WORLD_EDITOR_VIEWS, type WorldEditorView } from "@/lib/world-editor-selection";
import { fitMapLandmarks, landmarkErrors, type MapAlignmentDraft, type MapLandmark } from "@/lib/map-alignment";
import s from "./world-editor.module.css";
import m from "./map-artwork.module.css";
interface Context { scene: PlaceSceneSnapshot; baseline: PlaceSceneSnapshot; map: { id: string; root_id: string; title: string; url: string; reference_kind?: "parent_map" | "place_reference" }; registration: MapRegistration | null; alignment?: MapAlignmentDraft|null; alignment_stale?:boolean }
async function request(url: string, body?: unknown, method="POST") {
  const response = await fetch(url, body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load map artwork"); return data;
}
export default function MapArtworkEditor() {
  const [context, setContext] = useState<Context | null>(null), [endpoint, setEndpoint] = useState(""), [source, setSource] = useState("");
  const [registration, setRegistration] = useState<MapRegistration>({ x: 50, y: 50, width: 20, rotation: 0 });
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null), [confirmed, setConfirmed] = useState(false);
  const [overlay, setOverlay] = useState(true), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [returnView, setReturnView] = useState<WorldEditorView>("plan");
  const [camera, setCamera] = useState<string | null>(null), [floor, setFloor] = useState<string | null>(null);
  const [backHref, setBackHref] = useState("/");
  const [landmarks,setLandmarks]=useState<MapLandmark[]>([]),[marking,setMarking]=useState(false),[draftSaved,setDraftSaved]=useState(false);
  const [alignmentDirty, setAlignmentDirty] = useState(false), [projectionReviewed, setProjectionReviewed] = useState(false);
  const [correctionIds, setCorrectionIds] = useState<string[]>([]), [correction, setCorrection] = useState<WorldEditProposal | null>(null);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (alignmentDirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [alignmentDirty]);
  function changeAlignment() { setDraftSaved(false); setAlignmentDirty(true); setCorrection(null); setProjectionReviewed(false); }
  useEffect(() => {
    const controller = new AbortController(), query = new URLSearchParams(location.search), src = query.get("source") ?? ""; setSource(src);
    setBackHref(`/sketch/world?${query}`);
    void (async () => {
      if (!src && !query.get("world")) throw new Error("Open map artwork from a saved world");
      const place = await request(`/api/world/scene-context?${query}`);
      const path = `/api/world/${place.session_id}/places/${place.place_id}/map-artwork`, data: Context = await request(path);
      if (controller.signal.aborted) return;
      setEndpoint(path); setContext(data); setSource(src || data.scene.source_node_id || ""); if (data.registration) setRegistration(data.registration);
      if(data.alignment&&!data.alignment_stale){setLandmarks(data.alignment.landmarks);setDraftSaved(true);if(!data.registration)setRegistration(data.alignment.registration);}
      const selection = worldEditorSelection(data.scene.definition, query.get("object"), query.get("floor"));
      setSelected(selection.object_id); setFloor(selection.floor_id); setCamera(query.get("camera"));
      const view = query.get("view") as WorldEditorView; if (WORLD_EDITOR_VIEWS.includes(view)) setReturnView(view);
    })().catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!context) return;
    window.history.replaceState(null, "", worldEditorHref(context.scene, {object_id:selected, floor_id:floor}, {map:true, view:returnView, camera}));
  }, [context, selected, floor, returnView, camera]);
  function select(id: string) { if (!context) return; const next = worldEditorSelection(context.scene.definition, id, null); setSelected(next.object_id); setFloor(next.floor_id); setMarking(false); }
  const selectedObject=context?.scene.definition.objects.find(o=>o.id===selected&&!o.placement&&o.kind!=="path");
  const alignmentPreview=useMemo(()=>{if(!context||!frame)return {fit:null,error:""};try{return {fit:fitMapLandmarks(context.scene.definition,landmarks,frame),error:""};}catch(e){return {fit:null,error:(e as Error).message};}},[context,frame,landmarks]);
  const errors=context&&frame?landmarkErrors(context.scene.definition,landmarks,registration,frame):[];
  const diagnostic=landmarks.length>0||marking;
  const overlayScene=context&&(diagnostic?context.scene:context.baseline);
  const canRebase = !!context?.alignment_stale && context.alignment?.map_node_id === context.map.id && context.alignment.scene_id === context.scene.id && context.alignment.frame.width === frame?.width && context.alignment.frame.height === frame?.height;
  function rebaseDraft() {
    if (!canRebase || !context?.alignment) return;
    setLandmarks(context.alignment.landmarks.filter(p => context.scene.definition.objects.some(o => o.id === p.object_id && !o.placement && o.kind !== "path")));
    if (!context.registration) setRegistration(context.alignment.registration);
    setCorrectionIds([]); setMarking(false); changeAlignment();
  }
  function mark(x:number,y:number){if(!selectedObject)return;if(landmarks.length>=20&&!landmarks.some(p=>p.object_id===selectedObject.id)){setError("Use at most 20 landmarks");return;}setLandmarks(old=>[...old.filter(p=>p.object_id!==selectedObject.id),{object_id:selectedObject.id,x,y}]);setMarking(false);changeAlignment();}
  async function saveAlignment(){if(!context||!frame)return;setBusy(true);setError("");try{const result=await request(endpoint,{revision:context.alignment?.revision??0,scene_revision:context.scene.revision,map_node_id:context.map.id,frame,landmarks,registration},"PATCH");setContext(old=>old?{...old,alignment:result.alignment,alignment_stale:false}:old);setDraftSaved(true);setAlignmentDirty(false);setCorrection(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function previewCorrection() {
    if (!context?.alignment || !draftSaved || !projectionReviewed || !correctionIds.length) return;
    setBusy(true); setError(""); setCorrection(null);
    try {
      const result = await request(endpoint.replace(/map-artwork$/, "scene"), { action: "preview", base_revision: context.scene.revision, map_alignment: { revision: context.alignment.revision, object_ids: correctionIds, confirmed_projection: true } });
      setCorrection(result.proposal); setOverlay(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function applyCorrection() {
    if (!correction) return;
    setBusy(true); setError("");
    try {
      await request(endpoint.replace(/map-artwork$/, "scene"), { action: "apply", proposal_id: correction.id });
      const fresh: Context = await request(endpoint);
      setContext(fresh); setCorrection(null); setCorrectionIds([]); setProjectionReviewed(false); setDraftSaved(false); setAlignmentDirty(false); setConfirmed(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const preview = useMemo(() => {
    if (!context || !frame) return { state: null, error: "" };
    try { return { state: mapRepaintState(context.baseline.definition, context.scene.definition, registration, frame, context.scene.revision), error: "" }; }
    catch (e) { return { state: null, error: (e as Error).message }; }
  }, [context, registration, frame]);
  function update(patch: Partial<MapRegistration>) { if (context?.registration) return; setRegistration(old => ({ ...old, ...patch })); setConfirmed(false); changeAlignment(); setError(""); }
  async function prepare() {
    if (!context || !preview.state || !confirmed) return;
    setBusy(true); setError("");
    try {
      const data = await request(endpoint, { scene_revision: context.scene.revision, map_source_node_id: context.map.id, registration, frame, confirmed });
      location.assign(`/sketch?id=${encodeURIComponent(data.sketch.id)}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <main className={s.editor}>
    <header className={s.header}><a href={context ? worldEditorHref(context.scene, {object_id:selected, floor_id:floor}, {view:returnView, camera}) : backHref} title="World editor"><ArrowLeft size={18} />World</a><strong>Map artwork</strong><span className={s.status}>{context ? `${context.map.title} / geometry r${context.scene.revision}` : error ? "Artwork unavailable" : "Loading map..."}</span><button aria-label="Show geometry overlay" title="Show geometry overlay" aria-pressed={overlay} onClick={() => setOverlay(v => !v)}><Eye size={18} /></button></header>
    {error && <div className={s.error} role="alert">{error}</div>}
    {context && <div className={s.body}><section className={m.stage} aria-label="Map registration">
      <div className={m.artwork} style={frame ? { aspectRatio: `${frame.width}/${frame.height}` } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- R2 map; the editor reads naturalWidth/naturalHeight */}
        <img src={context.map.url} alt={context.map.reference_kind === "place_reference" ? "Current place reference artwork" : "Current parent map artwork"} onLoad={e => setFrame({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setError("Map image could not be loaded")} />
        {overlay && frame && <svg viewBox={`0 0 ${frame.width} ${frame.height}`} aria-label={diagnostic ? "Landmark alignment preview" : context.registration ? "Registered world footprints" : "Proposed world footprints"} className={m.overlay} onPointerDown={e => { if (busy) return; const box = e.currentTarget.getBoundingClientRect(); const point={x:Math.max(0,Math.min(100,(e.clientX-box.left)/box.width*100)),y:Math.max(0,Math.min(100,(e.clientY-box.top)/box.height*100))};if(marking){mark(point.x,point.y);return;}e.currentTarget.setPointerCapture(e.pointerId);update(point); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId) || busy) return; const box = e.currentTarget.getBoundingClientRect(); update({ x: Math.max(0, Math.min(100, (e.clientX - box.left) / box.width * 100)), y: Math.max(0, Math.min(100, (e.clientY - box.top) / box.height * 100)) }); }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}>
          {overlayScene!.definition.objects.filter(o => o.kind !== "path" && !o.placement).map(o => {
            const selectable = Boolean(!diagnostic && context.registration && context.scene.definition.objects.some(current => current.id === o.id) && !busy);
            return <polygon key={o.id} points={mapObject(o, overlayScene!.definition, registration, frame).points.map(p => `${p.x},${p.y}`).join(" ")}
              role={selectable ? "button" : undefined} tabIndex={selectable ? 0 : undefined} aria-label={selectable ? `Select ${o.label}` : undefined} aria-pressed={selectable ? selected === o.id : undefined}
              className={selectable ? m.selectable : undefined} fill={selected === o.id ? "#167a63" : "transparent"} fillOpacity={0.18} stroke={selected === o.id ? "#167a63" : "#167cb0"} strokeWidth={selected === o.id ? 3 : 1}
              onPointerDown={e => { if (selectable) e.stopPropagation(); }} onClick={e => { if (selectable) { e.stopPropagation(); select(o.id); } }}
              onKeyDown={e => { if (selectable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(o.id); } }}><title>{o.label}</title></polygon>;
          })}
          {errors.map(p=><g key={p.object_id} pointerEvents="none"><line x1={p.predicted.x} y1={p.predicted.y} x2={p.image.x} y2={p.image.y} stroke="#ac4537" strokeWidth={2}/><circle cx={p.image.x} cy={p.image.y} r={Math.max(4,frame.width/200)} fill="#fff" stroke="#ac4537" strokeWidth={2}/><title>{p.label}: {p.error.toFixed(1)} px</title></g>)}
          {correction?.definition.objects.filter(o => correctionIds.includes(o.id)).map(o => <polygon key={`correction-${o.id}`} aria-label={`Proposed position of ${o.label}`} pointerEvents="none" points={mapObject(o, correction.definition, registration, frame).points.map(p => `${p.x},${p.y}`).join(" ")} fill="#e9bd46" fillOpacity={0.2} stroke="#e9bd46" strokeWidth={4}><title>Proposed position of {o.label}</title></polygon>)}
          {!diagnostic&&preview.state?.scene.elements.map(e => <rect key={e.id} pointerEvents="none" x={e.x} y={e.y} width={e.width} height={e.height} transform={`rotate(${Number(e.angle) * 180 / Math.PI} ${e.x + e.width / 2} ${e.y + e.height / 2})`} fill={e.customData?.role === "mask" ? "#148aa8" : "none"} fillOpacity={0.22} stroke={String(e.strokeColor)} strokeWidth={2} strokeDasharray={e.customData?.role === "remove" ? "5 3" : undefined} />)}
        </svg>}
      </div>
    </section><aside className={s.inspector}>
      <h2>World selection</h2>
      <label>Object<select aria-label="Selected world object" value={selected ?? ""} disabled={busy} onChange={e => select(e.target.value)}><option value="">No object selected</option>{context.scene.definition.objects.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
      <p className={m.revision} role="status">{context.registration ? `Registered artwork / baseline r${context.baseline.revision}` : "Unregistered reference / placement preview"}</p>
      {selected && <a className={m.mapLink} href={worldEditorHref(context.scene, {object_id:selected, floor_id:floor}, {view:"orbit", camera})}><Focus size={16}/>Open selected object in 3D</a>}
      <h2>Plan placement</h2>
      <div className={s.fields}>{(["x", "y", "width", "rotation"] as const).map(key => <label key={key}>{({ x: "Centre X (%)", y: "Centre Y (%)", width: "Plan width (%)", rotation: "Rotation (deg)" })[key]}<input aria-label={`Map ${key}`} type="number" step={key === "rotation" ? 1 : 0.1} min={key === "rotation" ? -180 : key === "width" ? 1 : 0} max={key === "rotation" ? 180 : key === "width" ? 80 : 100} value={Number(registration[key].toFixed(3))} disabled={busy || Boolean(context.registration)} onChange={e => update({ [key]: Number(e.target.value) })} /></label>)}</div>
      {context.registration && <p className={m.revision}>Placement locked to accepted artwork</p>}
      <h2>Alignment landmarks</h2>
      <p className={m.revision}>Ground-footprint centres / image coordinates</p>
      {context.alignment_stale&&<p role="status">Saved draft is historical. Geometry or artwork changed.</p>}
      {canRebase && <button disabled={busy || alignmentDirty} onClick={rebaseDraft}><RefreshCw size={16}/>Rebase surviving landmarks</button>}
      <button aria-label="Mark selected landmark" aria-pressed={marking} disabled={busy||!selectedObject||!frame||(landmarks.length>=20&&!landmarks.some(p=>p.object_id===selected))} onClick={()=>{setOverlay(true);setMarking(v=>!v);}}><Crosshair size={16}/>{marking?`Mark ${selectedObject?.label}`:"Mark selected landmark"}</button>
      {selectedObject&&!landmarks.some(p=>p.object_id===selectedObject.id)&&<button disabled={busy||landmarks.length>=20} onClick={()=>mark(50,50)}><Crosshair size={16}/>Add landmark coordinates</button>}
      <ul className={m.landmarks}>{errors.map(p=><li key={p.object_id}><strong>{p.label}</strong><span>{p.error.toFixed(1)} px offset</span><div className={s.fields}>{(["x","y"] as const).map(axis=><label key={axis}>{axis.toUpperCase()} (%)<input aria-label={`${p.label} image ${axis}`} type="number" min={0} max={100} step={0.1} value={Number(p[axis].toFixed(3))} disabled={busy} onChange={e=>{const value=Math.max(0,Math.min(100,Number(e.target.value)));setLandmarks(old=>old.map(item=>item.object_id===p.object_id?{...item,[axis]:value}:item));changeAlignment();}}/></label>)}</div><label className={s.checkbox}><input type="checkbox" aria-label={`Correct ${p.label}`} checked={correctionIds.includes(p.object_id)} disabled={busy} onChange={e=>{setCorrectionIds(old=>e.target.checked?[...old,p.object_id]:old.filter(id=>id!==p.object_id));setCorrection(null);}}/>Correct position</label><button aria-label={`Remove landmark ${p.label}`} title={`Remove landmark ${p.label}`} disabled={busy} onClick={()=>{setLandmarks(old=>old.filter(item=>item.object_id!==p.object_id));setCorrectionIds(old=>old.filter(id=>id!==p.object_id));changeAlignment();}}><Trash2 size={16}/></button></li>)}</ul>
      <p role="status" className={m.revision}>{alignmentPreview.fit?`Proposed fit: RMS ${alignmentPreview.fit.rms.toFixed(1)} px / max ${alignmentPreview.fit.max.toFixed(1)} px / ${alignmentPreview.fit.healthy?"within tolerance, unaccepted":"outside tolerance"}`:alignmentPreview.error}</p>
      <button disabled={busy||!!context.registration||!alignmentPreview.fit} onClick={()=>{if(alignmentPreview.fit)update(alignmentPreview.fit.registration);}}><Scan size={16}/>Preview landmark fit</button>
      <button disabled={busy||!frame||draftSaved} onClick={()=>void saveAlignment()}><Save size={16}/>{draftSaved?"Alignment draft saved":"Save alignment draft"}</button>
      {alignmentDirty && <p role="status">Unsaved alignment changes</p>}
      {landmarks.length > 0 && <>
        <h2>Geometry correction</h2>
        <p className={m.revision}>Manual positions / approximate planar projection. Sizes, roofs and interiors unchanged.</p>
        <label className={s.checkbox}><input type="checkbox" aria-label="Approximate projection reviewed" checked={projectionReviewed} disabled={busy || !draftSaved || !!context.alignment_stale} onChange={e=>{setProjectionReviewed(e.target.checked);setCorrection(null);}}/>Approximate projection reviewed</label>
        <button disabled={busy || !draftSaved || !projectionReviewed || !correctionIds.length || !!context.alignment_stale} onClick={()=>void previewCorrection()}><Move size={16}/>Preview selected corrections</button>
        {correction && <section aria-label="Geometry correction preview"><h3>Review position changes</h3><ul>{correction.changes.map((text,i)=><li key={i}>{text}</li>)}</ul><p>{correction.affected_node_ids.length} saved images become historical. Artwork registration unchanged.</p><button disabled={busy} onClick={()=>void applyCorrection()}><Check size={16}/>Apply geometry correction</button><button disabled={busy} onClick={()=>setCorrection(null)}><X size={16}/>Cancel correction</button></section>}
      </>}
      <h2>Saved changes</h2><ul className={m.changes}>{mapChanges(context.baseline.definition, context.scene.definition).map((c, i) => <li key={i}>{c.after ? c.before ? "Update" : "Add" : "Remove"} {(c.after ?? c.before)!.label}</li>)}</ul>
      <p className={m.revision}>Baseline r{context.baseline.revision} / saved r{context.scene.revision}</p>
      <label className={s.checkbox}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />Map placement reviewed (approximate)</label>
      {preview.error && <p role="status">{preview.error}</p>}
      <button disabled={!confirmed || !preview.state || busy} onClick={() => void prepare()}><Paintbrush size={16} />{busy ? "Preparing..." : "Open repaint in Sketch"}</button>
      <a className={m.mapLink} href={context.scene.definition.material_pack === "ankh-street-v1" ? `/sketch/world/ankh?source=${encodeURIComponent(source)}&view=map` : `/n/${context.map.id}`}>Saved map artwork</a>
    </aside></div>}
  </main>;
}
