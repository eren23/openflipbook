import type { PlaceSceneDefinition } from "@openflipbook/config";
import { isSafeId } from "./ids";
import { mapObject, parseMapRegistration, type MapRegistration } from "./map-artwork";

export interface MapLandmark { object_id: string; x: number; y: number }
export interface MapAlignmentDraft {
  _id: string; session_id: string; place_id: string; scene_id: string;
  scene_revision: number; scene_source_node_id: string; map_node_id: string;
  revision: number; frame: { width: number; height: number }; landmarks: MapLandmark[];
  registration: MapRegistration;
  updated_at: Date | string;
}
export function parseMapLandmarks(value: unknown, definition: PlaceSceneDefinition): MapLandmark[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Use at most 20 landmarks");
  const ids = new Set<string>();
  return value.map(p => {
    const object = definition.objects.find(o => o.id === p?.object_id && !o.placement && o.kind !== "path");
    if (!p || !isSafeId(p.object_id) || !object || ids.has(p.object_id) || ![p.x,p.y].every(v=>typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100)) throw new Error("Invalid or duplicate map landmark");
    ids.add(p.object_id); return {object_id:p.object_id,x:p.x,y:p.y};
  });
}
export function parseAlignmentFrame(value: unknown) {
  const f=value as {width:number;height:number};
  if(!f || ![f.width,f.height].every(v=>Number.isSafeInteger(v)&&v>=32&&v<=8192))throw new Error("Invalid artwork dimensions");
  return {width:f.width,height:f.height};
}
export function landmarkErrors(definition:PlaceSceneDefinition,landmarks:MapLandmark[],registration:MapRegistration,frame:{width:number;height:number}) {
  return landmarks.map(p=>{
    const object=definition.objects.find(o=>o.id===p.object_id)!;
    const projected=mapObject(object,definition,registration,frame);
    const x=p.x/100*frame.width,y=p.y/100*frame.height;
    return {...p,label:object.label,predicted:{x:projected.cx,y:projected.cy},image:{x,y},error:Math.hypot(projected.cx-x,projected.cy-y)};
  });
}
// Orientation-preserving 2D similarity: unlike the legacy extraction register,
// never mirror the authored world or silently clamp a failed fit into range.
export function fitMapLandmarks(definition:PlaceSceneDefinition,raw:unknown,rawFrame:unknown) {
  const landmarks=parseMapLandmarks(raw,definition),frame=parseAlignmentFrame(rawFrame);
  if(landmarks.length<3)throw new Error("At least three spread-out landmarks are required");
  const pairs=landmarks.map(p=>{const o=definition.objects.find(o=>o.id===p.object_id)!;return {x:o.x,z:o.z,u:p.x/100*frame.width,v:p.y/100*frame.height};});
  const mean=(key:keyof typeof pairs[number])=>pairs.reduce((n,p)=>n+p[key],0)/pairs.length;
  const mx=mean("x"),mz=mean("z"),mu=mean("u"),mv=mean("v");
  let xx=0,zz=0,xz=0,dot=0,cross=0;
  for(const p of pairs){const x=p.x-mx,z=p.z-mz,u=p.u-mu,v=p.v-mv;xx+=x*x;zz+=z*z;xz+=x*z;dot+=x*u+z*v;cross+=x*v-z*u;}
  const spread=xx+zz;
  if(spread<1e-8 || (xx*zz-xz*xz)/(spread*spread)<0.005)throw new Error("Landmarks must cover an area, not a line");
  const a=dot/spread,b=cross/spread,scale=Math.hypot(a,b);
  const tx=mu-a*mx+b*mz,ty=mv-b*mx-a*mz;
  const registration=parseMapRegistration({x:(tx+a*definition.width/2-b*definition.depth/2)/frame.width*100,y:(ty+b*definition.width/2+a*definition.depth/2)/frame.height*100,width:scale*definition.width/frame.width*100,rotation:Math.atan2(b,a)*180/Math.PI});
  const errors=landmarkErrors(definition,landmarks,registration,frame),rms=Math.sqrt(errors.reduce((n,p)=>n+p.error*p.error,0)/errors.length),max=Math.max(...errors.map(p=>p.error)),diagonal=Math.hypot(frame.width,frame.height);
  return {registration,errors,rms,max,healthy:rms<=diagonal*0.01&&max<=diagonal*0.02};
}
