"use client";

/* eslint-disable @next/next/no-img-element -- Exact owned source and review pixels must bypass image optimization. */

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { ImageLedPoint, ImageLedWalkCreate, ImageLedWalkDetail, ImageLedWalkQuote, ImageLedWalkWire } from "@/lib/image-led-walk";
import { createPortal } from "react-dom";
import SavedWalkPlayer from "@/components/sketch/saved-walk-player";
import styles from "./ImageLedWalk.module.css";

interface SourceContext {
  node_id: string;
  map_frame: ImageLedWalkCreate["map_frame"];
  image: { sha256: string; width: number; height: number; bytes: number };
  image_url: string;
  landmarks: { id: string; entity_id: string | null; label: string; visual: string; crop_available: boolean }[];
  seeds?: { view_id: string; asset_id: string; sha256: string; label: string; image_url: string }[];
}
interface Props {
  sessionId: string; nodeId: string; mapFrame: ImageLedWalkCreate["map_frame"];
  points: ImageLedPoint[]; sourceImageUrl: string | null; open: boolean; onClose: () => void;
}
type Pending = { kind: "create"; body: ImageLedWalkCreate } | {
  kind: "schedule"; walk_id: string;
  body: { action: "schedule"; id: string; kind: "still" | "video"; index: number; quote: ImageLedWalkQuote; confirmed: true };
} | {
  kind: "fork"; walk_id: string; source_sha256: string; route_sha256: string; prefix_sha256: string[];
  body: { action: "fork"; id: string; index: number; revision: number };
};
const active = new Set(["scheduled", "submitting", "queued", "running"]);
/** Copied views (depth warp of the approved previous view) also need IMAGE_LED_WALK_COPY_FIRST_ENABLED on the backend. */
const COPY_FIRST = process.env.NEXT_PUBLIC_IMAGE_LED_COPY_FIRST === "1";
const reviewed = (frame: ImageLedWalkWire["frames"][number]) => frame.status === "ready" && !!frame.image && frame.review.sha256 === frame.image.sha256 && frame.review.identity === "approved" && frame.review.route === "approved";
const storageKey = (session: string, node: string) => `ofb:image-led:${session}:${node}`;
class RejectedRequest extends Error { constructor(message:string,public status:number){super(message);} }

/** Durable image-led work. No layout renderer, proxy camera or implicit provider submission. */
export function ImageLedWalk({ sessionId, nodeId, mapFrame: _mapFrame, points, sourceImageUrl, open, onClose }: Props) {
  const base = `/api/world/${encodeURIComponent(sessionId)}/image-led-walks`;
  const key = storageKey(sessionId,nodeId);
  const [source,setSource] = useState<SourceContext | null>(null);
  const [walks,setWalks] = useState<ImageLedWalkWire[]>([]);
  const [walk,setWalk] = useState<ImageLedWalkWire | null>(null);
  const [pending,setPending] = useState<Pending | null>(null);
  const [selection,setSelection] = useState<string[]>([]);
  const [crops,setCrops] = useState<NonNullable<ImageLedWalkCreate["landmark_crops"]>>([]);
  const [cropFor,setCropFor] = useState<string | null>(null);
  const [cropDraft,setCropDraft] = useState<{start:ImageLedPoint;end:ImageLedPoint} | null>(null);
  const [index,setIndex] = useState(0);
  const [kind,setKind] = useState<"still" | "video">("still");
  const [quote,setQuote] = useState<ImageLedWalkQuote | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [busy,setBusy] = useState(false);
  const [identity,setIdentity] = useState(false), [placement,setPlacement] = useState(false);
  const [temporal,setTemporal] = useState(false), [inspected,setInspected] = useState<number[]>([]);
  const [photoLoaded,setPhotoLoaded] = useState(false);
  const [notes,setNotes] = useState("");
  const [prompt,setPrompt] = useState("");
  const [seedId,setSeedId] = useState("");
  const pendingRef = useRef<Pending | null>(null), alive = useRef(true), writing = useRef(false);
  const walkRef = useRef<ImageLedWalkWire | null>(null), initialized = useRef(false);
  const cropStart = useRef<ImageLedPoint | null>(null), videoRef = useRef<HTMLVideoElement | null>(null);
  const seekSample = useRef<{index:number;time:number;sha256:string} | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const selectionRef = useRef({id:walk?.id,kind,index});
  selectionRef.current={id:walk?.id,kind,index};
  const frame = walk?.frames[index], leg = walk?.legs[index];
  const shownHash = kind === "still" ? frame?.image?.sha256 : leg?.video?.sha256;

  const retain = (value: Pending | null) => {
    if (value) {
      try{localStorage.setItem(`${key}:pending`,JSON.stringify(value));}
      catch{throw new Error("This browser cannot retain the request receipt. No step was submitted.");}
    }
    else localStorage.removeItem(`${key}:pending`);
    pendingRef.current = value; setPending(value);
  };
  const choose = useCallback((value: ImageLedWalkWire) => {
    if (value.session_id !== sessionId || value.source.node_id !== nodeId || value.profile !== "image-led-v1") throw new Error("Saved walk does not belong to this source map.");
    walkRef.current = value; setWalk(value); setQuote(null);
    setWalks(saved => saved.some(item => item.id === value.id) ? saved.map(item => item.id === value.id ? value : item) : [...saved, value]);
    try{localStorage.setItem(`${key}:selected`,value.id);}
    catch{setError("The route is saved on the server. This browser could not remember the selection; reopen it from saved routes.");}
  },[key,nodeId,sessionId]);
  const recoverPending = useCallback((saved: ImageLedWalkWire) => {
    const request = pendingRef.current;
    if (!request) return;
    if (request.kind === "create") {
      if (saved.id !== request.body.id) return;
      if (saved.source.node_id !== request.body.source_node_id || JSON.stringify(saved.route.points) !== JSON.stringify(request.body.points)) throw new Error("Saved request does not match the retained route. No replacement was selected.");
    } else if (request.kind === "fork") {
      if (saved.id !== request.body.id) return;
      if (!Array.isArray(request.prefix_sha256) || request.prefix_sha256.length !== request.body.index || saved.source.image.sha256 !== request.source_sha256 || saved.route.sha256 !== request.route_sha256 || request.prefix_sha256.some((hash, i) => saved.frames[i]?.image?.sha256 !== hash || !reviewed(saved.frames[i]!))) throw new Error("Saved fork does not match the retained reviewed prefix.");
      setKind("still"); setIndex(request.body.index);
    } else {
      if (saved.id !== request.walk_id) return;
      const slot = request.body.kind === "still" ? saved.frames[request.body.index] : saved.legs[request.body.index];
      if (slot?.job_id !== request.body.id) return;
    }
    localStorage.removeItem(`${key}:pending`); pendingRef.current=null;setPending(null);
  },[key]);
  const refresh = useCallback(async () => {
    const response = await fetch(`${base}?source_node_id=${encodeURIComponent(nodeId)}`);
    const body = await response.json() as { walks?: ImageLedWalkWire[]; source?: SourceContext; error?: string };
    if (!response.ok || !body.walks) throw new Error(body.error || "Saved illustrated walks are unavailable.");
    if (!alive.current) return;
    setWalks(body.walks);setSource(body.source ?? null);
    if (!initialized.current) {
      initialized.current=true;
      setSelection((body.source?.landmarks ?? []).filter(l=>l.crop_available).slice(0,4).map(l=>l.id));
    }
    const retained=pendingRef.current;
    const selectedId=walkRef.current?.id ?? localStorage.getItem(`${key}:selected`);
    const wanted=retained?.kind === "create" || retained?.kind === "fork" ? retained.body.id : retained?.walk_id ?? selectedId;
    const saved=body.walks.find(w=>w.id===wanted);
    if(saved){recoverPending(saved);choose(saved);}
    // An absent create receipt remains unresolved. This GET never reruns a POST.
  },[base,choose,key,nodeId,recoverPending]);
  useEffect(()=>{
    alive.current=true;initialized.current=false;walkRef.current=null;setWalk(null);setSource(null);setWalks([]);setPending(null);pendingRef.current=null;
    try{
      const value=localStorage.getItem(`${key}:pending`);
      if(value){const parsed=JSON.parse(value) as Pending;if(!["create","schedule","fork"].includes(parsed.kind))throw new Error("Invalid retained request");pendingRef.current=parsed;setPending(parsed);}
    }catch{setError("The retained request could not be read. No generation will be submitted.");writing.current=true;}
    void refresh().catch(failure=>{if(alive.current)setError(String(failure.message ?? failure));});
    return()=>{alive.current=false;};
  },[key,refresh]);
  useEffect(()=>{
    if(!pending && !walk?.frames.some(f=>active.has(f.status)) && !walk?.legs.some(l=>active.has(l.status)))return;
    const timer=setInterval(()=>{void refresh().catch(failure=>{if(alive.current)setError(String(failure.message ?? failure));});},2500);
    return()=>clearInterval(timer);
  },[pending,walk,refresh]);
  useEffect(()=>{setIdentity(false);setPlacement(false);setTemporal(false);setInspected([]);setPhotoLoaded(false);setNotes("");seekSample.current=null;videoRef.current?.pause();},[shownHash,index,kind]);
  useEffect(()=>{setQuote(null);},[index,kind]);
  useEffect(()=>{if(!open)videoRef.current?.pause();},[open]);
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[open]);

  const post = async (path: string,body: unknown) => {
    const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const result=await response.json() as {walk?:ImageLedWalkWire;error?:string};
    if(!response.ok && response.status>=400 && response.status<500)throw new RejectedRequest(result.error || "Request rejected; check source references.",response.status);
    if(!response.ok || !result.walk)throw new Error(result.error || "Acknowledgement unresolved. Check saved progress before continuing.");
    return result.walk;
  };
  const releaseRejectedRoute = async (failure:unknown) => {
    const request=pendingRef.current;
    if(!(failure instanceof RejectedRequest) || !request || !["create","fork"].includes(request.kind))return;
    // Only a proven rejection plus an owned GET proving no receipt lets the
    // user correct a draft. Network errors and paid requests stay retained.
    try{
      const response=await fetch(`${base}?source_node_id=${encodeURIComponent(nodeId)}`);
      const body=await response.json() as {walks?:ImageLedWalkWire[]};
      if(response.ok && body.walks && !body.walks.some(w=>w.id===request.body.id))retain(null);
    }catch{/* unresolved receipt stays retained */}
  };
  const create = async () => {
    if(writing.current || pendingRef.current || !source || points.length<2 || !selection.length)return;
    const missing=selection.filter(id=>!source.landmarks.find(l=>l.id===id)?.crop_available && !crops.some(c=>c.id===id));
    if(missing.length){setError("Mark and confirm a source-image reference for each selected place first.");return;}
    const seed=source.seeds?.find(s=>s.asset_id===seedId);
    if(seedId && !seed){setError("The selected starting painting is no longer eligible. Choose a current reviewed image.");return;}
    const body:ImageLedWalkCreate={id:crypto.randomUUID(),source_node_id:nodeId,map_frame:source.map_frame,points,landmark_ids:selection,...(seed?{seed:{view_id:seed.view_id,asset_id:seed.asset_id,sha256:seed.sha256}}:{}),...(prompt.trim()?{prompt:prompt.trim()}:{}),...(crops.length?{landmark_crops:crops.filter(c=>selection.includes(c.id))}:{})};
    writing.current=true;setBusy(true);setError(null);
    try{retain({kind:"create",body});const saved=await post(base,body);if(alive.current){recoverPending(saved);choose(saved);setKind("still");setIndex(0);}}
    catch(failure){await releaseRejectedRoute(failure);if(alive.current)setError(String((failure as Error).message));}
    finally{writing.current=false;if(alive.current)setBusy(false);}
  };
  const requestQuote = async (mode?: "copy_first") => {
    if(!walk || writing.current || pendingRef.current)return;
    const requestedWalk=walk.id, requestedKind=kind, requestedIndex=index;
    setBusy(true);setError(null);setQuote(null);
    try{
      const response=await fetch(`${base}/${encodeURIComponent(walk.id)}?kind=${kind}&index=${index}${mode ? `&mode=${mode}` : ""}`);
      const body=await response.json() as ImageLedWalkDetail & {error?:string};
      if(!response.ok || !body.walk)throw new Error(body.error || "Quote unavailable.");
      if(body.walk.id!==requestedWalk)throw new Error("Quote returned another walk.");
      const q=body.quote;
      if(q && (q.kind!==requestedKind || q.index!==requestedIndex || q.profile!=="image-led-v1" || q.source_sha256!==body.walk.source.image.sha256 || q.binding_sha256!==body.walk.source.binding_sha256 || q.route_sha256!==body.walk.route.sha256 || q.retry_allowance!==0 || q.spatial_validation!=="unmeasured" || !Number.isFinite(q.reservation) || q.reservation<=0 || !!q.copy_first!==(mode==="copy_first")))throw new Error("Quote does not match this source and route.");
      if(alive.current && selectionRef.current.id===requestedWalk && selectionRef.current.kind===requestedKind && selectionRef.current.index===requestedIndex){choose(body.walk);setQuote(q);if(!q)setError(body.reason || "This step is not ready to generate.");}
    }catch(failure){if(alive.current)setError(String((failure as Error).message));}
    finally{if(alive.current)setBusy(false);}
  };
  const fork = async () => {
    if (!walk || writing.current || pendingRef.current || kind !== "still" || !walk.frames.slice(0, index).every(reviewed)) return;
    const body = { action: "fork" as const, id: crypto.randomUUID(), index, revision: walk.revision };
    const request: Pending = { kind: "fork", walk_id: walk.id, source_sha256: walk.source.image.sha256, route_sha256: walk.route.sha256, prefix_sha256: walk.frames.slice(0, index).map(f => f.image!.sha256), body };
    writing.current = true; setBusy(true); setError(null); setQuote(null);
    try { retain(request); const saved = await post(`${base}/${encodeURIComponent(walk.id)}`, body); if (alive.current) { recoverPending(saved); choose(saved); setKind("still"); setIndex(body.index); } }
    catch (failure) { await releaseRejectedRoute(failure); if (alive.current) setError(String((failure as Error).message)); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const schedule = async () => {
    if(!walk || !quote || writing.current || pendingRef.current || quote.kind!==kind || quote.index!==index)return;
    const body={action:"schedule" as const,id:crypto.randomUUID(),kind,index,quote,confirmed:true as const};
    writing.current=true;setBusy(true);setError(null);
    try{retain({kind:"schedule",walk_id:walk.id,body});const saved=await post(`${base}/${encodeURIComponent(walk.id)}`,body);if(alive.current){recoverPending(saved);choose(saved);}}
    catch(failure){if(alive.current)setError(String((failure as Error).message));}
    finally{writing.current=false;if(alive.current)setBusy(false);}
  };
  const recover = async () => {
    const request=pendingRef.current;
    if(!request || writing.current)return;
    writing.current=true;setBusy(true);setError(null);
    try{
      const path=request.kind==="create"?base:`${base}/${encodeURIComponent(request.walk_id)}`;
      const saved=await post(path,request.body);
      if(alive.current){recoverPending(saved);choose(saved);}
    }catch(failure){await releaseRejectedRoute(failure);if(alive.current)setError(String((failure as Error).message));}
    finally{writing.current=false;if(alive.current)setBusy(false);}
  };
  const review = async (approved:boolean) => {
    if(!walk || writing.current || pendingRef.current || !shownHash)return;
    if(approved && (kind==="still" ? !identity || !placement || !photoLoaded : !temporal || inspected.length<3))return;
    writing.current=true;setBusy(true);setError(null);
    const body={action:"review",kind,index,sha256:shownHash,...(kind==="still"?{identity:approved?"approved":"rejected",route:approved?"approved":"rejected"}:{temporal:approved?"approved":"rejected"}),...(notes.trim()?{notes:notes.trim()}:{})};
    try{const saved=await post(`${base}/${encodeURIComponent(walk.id)}`,body);if(alive.current)choose(saved);}
    catch(failure){if(alive.current)setError(String((failure as Error).message));}
    finally{writing.current=false;if(alive.current)setBusy(false);}
  };
  const sourcePoints=walk?.route.points ?? points;
  const mapUrl=walk?.source.image_url ?? source?.image_url ?? sourceImageUrl;
  const stillsApproved=!!walk && walk.frames.length>1 && walk.frames.every(reviewed);
  const slot=kind==="still"?frame:leg;
  const disabled=busy || !!pending || writing.current || walk?.status==="archived";
  const pointFromEvent=(event:PointerEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),y:Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height))};};
  if(!open)return null;
  return createPortal(<section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Image-led illustrated walk" className={`${styles.panel} fixed inset-3 z-50 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-4 shadow-xl md:inset-8`}
    onKeyDown={event=>{
      if(event.key==="Escape"){event.preventDefault();onClose();return;}
      if(event.key!=="Tab")return;
      const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex='0']"));
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }}>
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl">Create an illustrated walk</h2><button type="button" onClick={onClose}>Back to map</button></header>
    <p className="my-2 text-sm">Keep the original buildings and painted detail. Route positions and facing directions are estimated on this image, not calibrated ground coordinates.</p>
    {error && <p role="alert" className="my-2 text-sm text-red-700">{error}</p>}
    {pending && <div><p role="status">Request retained. Checking saved progress; no new generation request will be created.</p><button type="button" disabled={busy} onClick={()=>void recover()}>Recover this same request</button><p className="text-xs">Reuses the exact saved request and ID. An existing provider job is never submitted again.</p></div>}
    <div className="grid gap-4 lg:grid-cols-2">
      <div><h3>Original source map</h3>{mapUrl && <div className="relative overflow-hidden" data-testid="image-led-source-map"
        style={{touchAction:cropFor?"none":"auto"}}
        onPointerDown={event=>{if(!cropFor)return;event.preventDefault();cropStart.current=pointFromEvent(event);setCropDraft({start:cropStart.current,end:cropStart.current});event.currentTarget.setPointerCapture?.(event.pointerId);}}
        onPointerMove={event=>{if(cropFor && cropStart.current)setCropDraft({start:cropStart.current,end:pointFromEvent(event)});}}
        onPointerUp={()=>{cropStart.current=null;}} onPointerCancel={()=>{cropStart.current=null;setCropDraft(null);}}>
        {/* Exact source URL is served by the owner route; no pixel rewriting. */}
        <img src={mapUrl} alt="Original illustrated source map" className="block h-auto w-full" draggable={false}/>
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden><defs><marker id="image-led-direction" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="3" markerHeight="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L10 5 L0 10Z" fill="#f8d474"/></marker></defs><polyline points={sourcePoints.map(p=>`${p.x*100},${p.y*100}`).join(" ")} fill="none" stroke="#f8d474" strokeWidth=".5" strokeDasharray="1 1"/>
          {sourcePoints.map((p,i)=>{const next=sourcePoints[Math.min(i+1,sourcePoints.length-1)],prev=sourcePoints[Math.max(0,i-1)];if(!next||!prev)return null;const len=Math.hypot(next.x-prev.x,next.y-prev.y)||1;return <line key={i} x1={p.x*100} y1={p.y*100} x2={p.x*100+(next.x-prev.x)/len*3} y2={p.y*100+(next.y-prev.y)/len*3} stroke="#f8d474" strokeWidth=".5" markerEnd="url(#image-led-direction)"/>;})}
          {sourcePoints.map((p,i)=>{const labelX=Math.max(.06,Math.min(.94,p.x+(i%2===0?-.07:.07)));return <g key={`origin-${i}`}><line x1={p.x*100} y1={p.y*100} x2={labelX*100} y2={p.y*100} stroke="#f8d474" strokeWidth=".35"/><circle cx={p.x*100} cy={p.y*100} r=".65" fill="#f8d474" stroke="#29211a" strokeWidth=".2"/></g>;})}
        </svg>
        {sourcePoints.map((p,i)=><button key={i} type="button" aria-label={`Source position ${i+1}`} aria-pressed={i===index} disabled={!!cropFor} className={styles.sourceMarker} style={{left:`${Math.max(.06,Math.min(.94,p.x+(i%2===0?-.07:.07)))*100}%`,top:`${p.y*100}%`}} onClick={()=>{setIndex(kind==="video"?Math.min(i,Math.max(0,(walk?.legs.length ?? 1)-1)):i);}}>{i+1}</button>)}
        {cropDraft && <div className="pointer-events-none absolute border-2 border-green-500 bg-green-500/20" style={{left:`${Math.min(cropDraft.start.x,cropDraft.end.x)*100}%`,top:`${Math.min(cropDraft.start.y,cropDraft.end.y)*100}%`,width:`${Math.abs(cropDraft.end.x-cropDraft.start.x)*100}%`,height:`${Math.abs(cropDraft.end.y-cropDraft.start.y)*100}%`}}/>}
      </div>}
      {cropFor && <div><p>Drag around this place in the original image. Confirm its source pixels, not a footprint on the ground.</p><button type="button" disabled={!cropDraft || Math.abs(cropDraft.end.x-cropDraft.start.x)*(source?.image.width??0)<32 || Math.abs(cropDraft.end.y-cropDraft.start.y)*(source?.image.height??0)<32} onClick={()=>{if(!cropDraft)return;const crop={id:cropFor,x:Math.min(cropDraft.start.x,cropDraft.end.x),y:Math.min(cropDraft.start.y,cropDraft.end.y),w:Math.abs(cropDraft.end.x-cropDraft.start.x),h:Math.abs(cropDraft.end.y-cropDraft.start.y),confirmed:true as const};setCrops(prev=>[...prev.filter(c=>c.id!==cropFor),crop]);setCropFor(null);setCropDraft(null);}}>Confirm source reference</button><button type="button" onClick={()=>{setCropFor(null);setCropDraft(null);}}>Cancel crop</button></div>}
      <p className="mt-2 text-xs">Each marker shows the source-image position for that street painting.</p>
      {walk && <div className="mt-3 flex flex-wrap gap-2">{walk.landmarks.map(l=><figure key={l.id} className="max-w-36"><img src={l.image_url} alt={`Original source reference: ${l.label}`} className="h-24 w-32 object-contain"/><figcaption className="text-xs">{l.label} · original pixels</figcaption></figure>)}</div>}
      </div>
      <div>
      {!walk ? <><h3>Choose the original places to preserve</h3><div className="my-2 space-y-2">{source?.landmarks.map(l=><div key={l.id}><label><input type="checkbox" checked={selection.includes(l.id)} disabled={!selection.includes(l.id)&&selection.length>=8} onChange={event=>setSelection(prev=>event.target.checked?[...prev,l.id]:prev.filter(id=>id!==l.id))}/> {l.label}</label>{selection.includes(l.id)&&!l.crop_available&&<button type="button" className="ml-2 underline" onClick={()=>{setCropFor(l.id);setCropDraft(null);}}>{crops.some(c=>c.id===l.id)?"Change confirmed source crop":"Mark source reference"}</button>}</div>)}</div>
      <label className="block">Starting painting<select value={seedId} onChange={event=>setSeedId(event.target.value)} className="my-2 block w-full rounded border bg-[var(--color-canvas)] p-2"><option value="">Start from the original map</option>{source?.seeds?.map(seed=><option key={seed.asset_id} value={seed.asset_id}>{seed.label} · reviewed</option>)}</select></label>
      {seedId && source?.seeds?.find(s=>s.asset_id===seedId) && <figure><img src={source.seeds.find(s=>s.asset_id===seedId)!.image_url} alt="Chosen reviewed starting painting" className="my-2 w-full"/><figcaption>This exact painting becomes the first checkpoint. Confirm its route position before generating the next view.</figcaption></figure>}
      <label className="block">What should this walk preserve?<textarea value={prompt} onChange={event=>setPrompt(event.target.value)} className="my-2 block w-full rounded border bg-transparent p-2" placeholder="Original bay windows, hanging signs, roof shapes and warm painted detail"/></label><p>Save the route for free, then quote each image before generating. Images are reviewed before any clip.</p><button type="button" disabled={disabled || !source || points.length<2 || !selection.length} onClick={()=>void create()}>Save image-led route — free</button>{!points.length&&<p>Draw a route on the map first, or open a saved route below.</p>}</> : <>
      <div role="group" aria-label="Review stage" className="flex flex-wrap gap-2"><button type="button" aria-pressed={kind==="still"} onClick={()=>{setKind("still");setIndex(0);}}>Street paintings</button><button type="button" aria-pressed={kind==="video"} onClick={()=>{setKind("video");setIndex(0);}}>Walking clips</button><button type="button" disabled={disabled} onClick={()=>{walkRef.current=null;setWalk(null);setQuote(null);localStorage.removeItem(`${key}:selected`);}}>Prepare another route</button></div>
      <div role="group" aria-label={kind==="still"?"Saved checkpoints":"Saved walking legs"} className="my-3 flex flex-wrap gap-2">{(kind==="still"?walk.frames:walk.legs).map((item,i)=><button key={i} type="button" aria-pressed={i===index} onClick={()=>setIndex(i)}>{kind==="still"?`View ${i+1}`:`Leg ${i+1}`} · {item.status.replaceAll("_"," ")}</button>)}</div>
      <p role="status">{walk.status==="archived"?"Archived preview; generation disabled":slot?.status.replaceAll("_"," ") ?? "Choose a checkpoint"} · Camera match unmeasured</p>
      {slot?.error&&<p role="alert">{slot.error}</p>}
      {kind==="still" && frame?.image_url && <><img key={frame.image?.sha256} src={frame.image_url} alt={walk.seed && index===0?"Reviewed starting painting reused at checkpoint 1":`Generated street painting at source checkpoint ${index+1}`} onLoad={()=>setPhotoLoaded(true)} onError={()=>{setPhotoLoaded(false);setError("Saved painting unavailable; review is disabled.");}} className="my-3 block h-auto w-full"/><p className="text-sm">{walk.seed && index===0?"Exact reviewed starting painting reused":frame.copy_first?`Copied view: view ${index} moved forward with a depth map (image-plane turn ${frame.copy_first.yaw_degrees.toFixed(1)}°); every pixel comes from that reviewed view`:"Generated interpretation of the original map"} at position {index+1}. Identity: {frame.review.identity}; route: {frame.review.route}.</p>
      {index>0 && walk.frames[index-1] && reviewed(walk.frames[index-1]!) && walk.frames[index-1]!.image_url && <figure className="my-3"><img src={walk.frames[index-1]!.image_url} alt="Previous reviewed street painting" className="max-h-56 w-full object-contain"/><figcaption className="text-xs">Previous reviewed checkpoint · Compare door/window order, signs and roof shapes.</figcaption></figure>}
      <label className="my-2 block"><input type="checkbox" checked={identity} onChange={event=>setIdentity(event.target.checked)}/> These are the same buildings and façade details as the source.</label><label className="my-2 block"><input type="checkbox" checked={placement} onChange={event=>setPlacement(event.target.checked)}/> Position, facing direction and neighbouring buildings fit this drawn route.</label></>}
      {kind==="video" && leg?.video_url && <>{leg.review.temporal==="approved"?<SavedWalkPlayer src={leg.video_url} width={leg.media?.width ?? 16} height={leg.media?.height ?? 9}/>:<><video ref={videoRef} controls playsInline muted preload="metadata" src={leg.video_url} className="my-3 w-full" onSeeked={event=>{const sample=seekSample.current;if(sample&&sample.sha256===leg.video?.sha256&&event.currentTarget.readyState>=2&&Math.abs(event.currentTarget.currentTime-sample.time)<.04){setInspected(prev=>prev.includes(sample.index)?prev:[...prev,sample.index]);seekSample.current=null;}}}/><div className="flex flex-wrap gap-2">{[.15,.5,.85].map((time,i)=><button key={time} type="button" aria-pressed={inspected.includes(i)} onClick={()=>{const video=videoRef.current;if(video&&leg.video&&Number.isFinite(video.duration)&&video.duration>0){video.pause();seekSample.current={index:i,time:video.duration*time,sha256:leg.video.sha256};video.currentTime=video.duration*time;}}}>Inspect {i===0?"early":i===1?"middle":"late"} frame</button>)}</div></>}
      <p>Leg {index+1}: reviewed view {(leg.from ?? index)+1} → {(leg.to ?? index+1)+1}. Generated motion must retain door/window order, signs and architecture throughout.</p><label className="my-2 block"><input type="checkbox" checked={temporal} onChange={event=>setTemporal(event.target.checked)}/> I watched the motion and checked intermediate frames for changing architecture.</label></>}
      {shownHash && slot?.status==="ready" && walk.status!=="archived" && <><label className="block">Review notes<textarea value={notes} onChange={event=>setNotes(event.target.value)} className="my-2 block w-full rounded border bg-transparent p-2"/></label><div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || (kind==="still"?!identity||!placement||!photoLoaded:!temporal||(inspected.length<3&&leg?.review.temporal!=="approved"))} onClick={()=>void review(true)}>Approve {kind==="still"?"identity and route":"temporal continuity"}</button><button type="button" disabled={disabled} onClick={()=>void review(false)}>Reject {kind==="still"?"painting":"motion"}</button></div></>}
      {kind === "still" && frame && walk.status !== "archived" && (frame.status === "failed" || frame.review.identity === "rejected" || frame.review.route === "rejected") && <div className="my-3 rounded border p-3"><p>Keep the reviewed earlier views and preserve this attempt. A new quote is required before generating.</p><button type="button" disabled={disabled || !walk.frames.slice(0, index).every(reviewed) || [...walk.frames, ...walk.legs].some(s => !["empty", "ready", "failed"].includes(s.status))} onClick={() => void fork()}>New attempt from this position — free</button></div>}
      {(!slot || slot.status==="empty") && <div className="my-3">{kind==="video"&&!stillsApproved&&<p>Review every street painting for source identity and route placement before generating a walking clip.</p>}<button type="button" disabled={disabled || !slot || kind==="video"&&!stillsApproved} onClick={()=>void requestQuote()}>Quote {kind==="still"?"this painting":"this walking clip"} — free</button>{COPY_FIRST && kind==="still" && index>0 && walk.frames[index-1] && reviewed(walk.frames[index-1]!) && <button type="button" disabled={disabled || !slot} onClick={()=>void requestQuote("copy_first")}>Quote copied view (depth warp) — free</button>}</div>}
      {quote && <div className="my-3 rounded border p-3"><p>{quote.copy_first?`One copied view: moves view ${index} forward with a depth map, image-plane turn ${quote.copy_first.yaw_degrees.toFixed(1)}° from the drawn route (not a measured camera). No painted pixels; it fails if any pixel is not in view ${index}`:kind==="still"?"One street painting":"One walking clip"} · up to ${quote.reservation.toFixed(2)} · no automatic retries</p><button type="button" disabled={disabled} onClick={()=>void schedule()}>Generate {quote.copy_first?"copied view":kind==="still"?"painting":"clip"} — up to ${quote.reservation.toFixed(2)}</button></div>}
      </>}
      <button type="button" disabled={busy} className="mt-4 underline" onClick={()=>{setError(null);void refresh().catch(failure=>setError(String(failure.message ?? failure)));}}>Check saved progress — free</button>
      {!!walks.length && <div role="group" aria-label="Saved image-led routes" className="mt-3 flex flex-wrap gap-2">{walks.map((item,i)=><button key={item.id} type="button" disabled={!!pending || busy} aria-pressed={item.id===walk?.id} onClick={()=>{choose(item);setKind("still");setIndex(0);}}>Saved route {i+1} · {item.status.replaceAll("_"," ")}</button>)}</div>}
      </div>
    </div>
  </section>, document.body);
}
