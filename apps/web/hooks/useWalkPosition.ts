"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {parseWalkPose, type WalkPose} from "@/lib/walk-position";
import {WalkPositionSync, type PositionSaveState} from "@/lib/walk-position-sync";

export function useWalkPosition(sid: string | null) {
  const sync=useRef<WalkPositionSync|null>(null);
  const [loaded,setLoaded]=useState<string|null>(null),[attempt,setAttempt]=useState(0);
  const [state,setState]=useState<PositionSaveState>({status:"idle"});
  useEffect(()=>{
    if(!sid)return;
    let active=true;
    const abort=new AbortController(),url=`/api/creator/worlds/${encodeURIComponent(sid)}/walk`;
    setState({status:"idle"});setLoaded(null);
    void (async()=>{
      const res=await fetch(url,{cache:"no-store",signal:abort.signal}),data=await res.json();
      if(!res.ok)throw new Error(data.error??"Saved position unavailable");
      if(!Number.isSafeInteger(data.revision)||data.revision<0||(data.pose!==null&&!parseWalkPose(data.pose)))throw new Error("Invalid saved position");
      if(!active)return;
      sync.current=new WalkPositionSync(url,{revision:data.revision,pose:data.pose},s=>{if(active)setState(s);});
      setState({status:data.pose?"saved":"idle"});
      setLoaded(sid);
    })().catch(e=>{if(active)setState({status:"error",message:(e as Error).message});});
    const flush=()=>{void sync.current?.flush();};
    const hidden=()=>{if(document.visibilityState==="hidden")flush();};
    window.addEventListener("pagehide",flush);document.addEventListener("visibilitychange",hidden);
    return ()=>{active=false;abort.abort();sync.current?.close();sync.current=null;window.removeEventListener("pagehide",flush);document.removeEventListener("visibilitychange",hidden);};
  },[sid,attempt]);
  const getPose=useCallback(()=>sync.current?.getPose()??null,[]);
  const record=useCallback((pose:WalkPose)=>sync.current?.record(pose),[]);
  const flush=useCallback(()=>{void sync.current?.flush();},[]);
  const retry=()=>{if(sync.current)void sync.current.retry();else setAttempt(n=>n+1);};
  return {ready:!sid||loaded===sid,getPose,record,flush,retry,state};
}
