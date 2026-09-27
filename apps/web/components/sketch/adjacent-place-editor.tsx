"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Eye, RefreshCw, Sparkles } from "lucide-react";
import type { BuildingSide, PlaceSceneSnapshot, WorldEditProposal } from "@openflipbook/config";
import { emptyPlaceScene } from "@/lib/place-scene";
import { reservationLabel } from "@/lib/reservation-label";
import s from "./world-editor.module.css";

export default function AdjacentPlaceEditor({scene,disabled,onSaved,onBusy}:{scene:PlaceSceneSnapshot;disabled:boolean;onSaved:(placeId?:string)=>Promise<void>;onBusy:(busy:boolean)=>void}){
  const [name,setName]=useState(""),[side,setSide]=useState<BuildingSide>("east");
  const [width,setWidth]=useState(scene.definition.width),[depth,setDepth]=useState(scene.definition.depth),[opening,setOpening]=useState(3);
  const [preview,setPreview]=useState<{proposal:WorldEditProposal;place_id:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [generate,setGenerate]=useState(false),[prompt,setPrompt]=useState(""),[confirmed,setConfirmed]=useState(false),[refresh,setRefresh]=useState(0);
  const [config,setConfig]=useState<{enabled:boolean;model?:string;reservation?:number;reason?:string}|null>(null);
  const pending=useRef<Record<string,unknown>|null>(null);
  const endpoint=`/api/world/${encodeURIComponent(scene.session_id)}/places/${encodeURIComponent(scene.place_id)}/connections`;
  useEffect(()=>{
    if(!generate)return;
    let stopped=false;setConfig(null);setConfirmed(false);
    void fetch(`${endpoint}?generation=1`,{cache:"no-store"}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error??"Layout generation unavailable");if(!stopped)setConfig(data.capabilities);}).catch(e=>{if(!stopped)setConfig({enabled:false,reason:e.message});});
    return()=>{stopped=true;};
  },[generate,endpoint,refresh]);
  async function post(url:string,body:unknown){const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error??"Could not save adjoining place"),{status:r.status});return data;}
  async function review(){
    setBusy(true);onBusy(true);setError("");
    try{setPreview(await post(endpoint,{side,width:opening,source_revision:scene.revision,definition:{...emptyPlaceScene(),label:name,width,depth,entrance:{x:width/2,z:depth-1.2,yaw:0}}}));}
    catch(e){setError((e as Error).message);}finally{setBusy(false);onBusy(false);}
  }
  async function apply(){
    if(!preview||busy||disabled)return;
    if(generate&&!pending.current){
      if(!config?.enabled||!confirmed||prompt.trim().length<3)return;
      pending.current={action:"generate",place_id:preview.place_id,proposal_id:preview.proposal.id,prompt,confirmed:true,model:config.model,reservation:config.reservation};
    }
    setBusy(true);onBusy(true);setError("");
    try{
      if(pending.current){const result=await post(endpoint,pending.current);await onSaved(result.place_id);pending.current=null;}
      else{await post(`/api/world/${scene.session_id}/places/${preview.place_id}/scene`,{action:"apply",proposal_id:preview.proposal.id});await onSaved();}
      setPreview(null);setConfirmed(false);
    }
    catch(e){
      if([400,403,404,409,413,429].includes((e as Error&{status?:number}).status??0)){pending.current=null;setConfirmed(false);setRefresh(n=>n+1);}
      setError((e as Error).message);
    }finally{setBusy(false);onBusy(false);}
  }
  const changed=()=>{setPreview(null);setConfirmed(false);setError("");};
  const amount=config?.reservation;
  const price=typeof amount==="number"?reservationLabel(amount):"";
  return <details><summary>Add adjoining area</summary>
    <fieldset className={s.connectionFields} disabled={disabled||busy||!!pending.current} onChange={changed}>
      <label>Area name<input aria-label="Adjoining area name" value={name} maxLength={160} onChange={e=>setName(e.target.value)}/></label>
      <div className={s.addRow} role="group" aria-label="Expansion direction">{([["north",ArrowUp],["east",ArrowRight],["south",ArrowDown],["west",ArrowLeft]] as const).map(([value,Icon])=><button key={value} type="button" title={`Expand ${value}`} aria-label={`Expand ${value}`} aria-pressed={side===value} onClick={()=>{setSide(value);changed();}}><Icon size={17}/></button>)}</div>
      <div className={s.fields}><label>Width (m)<input aria-label="Adjoining width" type="number" min={4} max={100} value={width} onChange={e=>setWidth(Number(e.target.value))}/></label><label>Depth (m)<input aria-label="Adjoining depth" type="number" min={4} max={100} value={depth} onChange={e=>setDepth(Number(e.target.value))}/></label></div>
      <label>Opening width (m)<input aria-label="Connection width" type="number" min={1.2} max={20} step={0.2} value={opening} onChange={e=>setOpening(Number(e.target.value))}/></label>
      <button type="button" disabled={!name.trim()} onClick={()=>void review()}><Eye size={16}/>Preview adjoining area</button>
    </fieldset>
    <fieldset className={s.connectionFields} disabled={disabled||busy||!!pending.current}>
      <label className={s.checkbox}><input type="checkbox" checked={generate} onChange={e=>{setGenerate(e.target.checked);setConfirmed(false);}}/>Generate layout in new area</label>
      {generate&&<>
        <label>Adjoining area description<textarea aria-label="Adjoining area description" maxLength={4000} value={prompt} onChange={e=>{setPrompt(e.target.value);setConfirmed(false);}}/></label>
        <div className={s.sectionHeading}><span>{config?.model??"Layout generation"}</span><button type="button" title="Refresh adjoining generation availability" aria-label="Refresh adjoining generation availability" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={16}/></button></div>
        {config?.enabled&&typeof config.reservation==="number"?<label className={s.checkbox}><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Reserve ${price} for adjoining layout only</label>:<p role="status">{config?.reason??"Checking layout generation availability..."}</p>}
      </>}
    </fieldset>
    {error&&<p role="alert" className={s.error}>{error}</p>}
    {preview&&<section className={s.proposal} aria-label="Connection preview"><h2>{preview.proposal.definition.label}</h2><ul>{preview.proposal.changes.map(c=><li key={c}>{c}</li>)}</ul><p>{width} x {depth} m</p><button disabled={busy||disabled||generate&&!pending.current&&(!config?.enabled||!confirmed||prompt.trim().length<3)} onClick={()=>void apply()}>{generate?<Sparkles size={16}/>:<Check size={16}/>} {pending.current?"Retry saved expansion":generate?"Create and generate":"Apply adjoining area"}</button><button disabled={busy||!!pending.current} onClick={()=>{setPreview(null);setConfirmed(false);}}>Cancel</button></section>}
  </details>;
}
