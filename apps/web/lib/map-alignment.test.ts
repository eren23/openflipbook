import {expect,it} from "vitest";
import {emptyPlaceScene,newComponent} from "./place-scene";
import {mapObject} from "./map-artwork";
import {fitMapLandmarks,parseMapLandmarks} from "./map-alignment";
const definition={...emptyPlaceScene(),objects:[[8,8],[28,8],[8,28],[28,28]].map(([x,z],i)=>({...newComponent("house",x!,z!),id:`house_${i}`}))};
const frame={width:1600,height:900},registration={x:50,y:50,width:40,rotation:17};
const landmarks=definition.objects.map(o=>{const p=mapObject(o,definition,registration,frame);return {object_id:o.id,x:100*p.cx/frame.width,y:100*p.cy/frame.height};});
it("recovers rotation, translation and uniform scale with pixel-correct aspect ratio",()=>{
  const f=fitMapLandmarks(definition,landmarks,frame);expect(f.healthy).toBe(true);expect(f.rms).toBeLessThan(1e-8);
  for(const key of ["x","y","width","rotation"] as const)expect(f.registration[key]).toBeCloseTo(registration[key],8);
});
it("retains a poor fit as a failure, not a mirrored or clamped success",()=>{
  const bad=landmarks.map((p,i)=>({...p,x:p.x+(i===0?15:0)}));
  expect(fitMapLandmarks(definition,bad,frame).healthy).toBe(false);
  expect(()=>fitMapLandmarks(definition,landmarks.map(p=>({...p,x:100-p.x})),frame)).toThrow();
});
it("requires independent spread-out identities, not labels or exactly determined pairs",()=>{
  expect(()=>fitMapLandmarks(definition,landmarks.slice(0,2),frame)).toThrow("three");
  expect(()=>parseMapLandmarks([landmarks[0],landmarks[0]],definition)).toThrow("duplicate");
  expect(()=>parseMapLandmarks([{...landmarks[0],object_id:"unknown"}],definition)).toThrow();
  expect(()=>parseMapLandmarks([{...landmarks[0],x:NaN}],definition)).toThrow();
  const line={...definition,objects:definition.objects.map((o,i)=>({...o,x:i*5,z:10}))};
  expect(()=>fitMapLandmarks(line,landmarks,frame)).toThrow("not a line");
});
it("does not alter authored geometry while diagnosing an oblique or inconsistent reference",()=>{
  const before=structuredClone(definition);fitMapLandmarks(definition,landmarks,frame);expect(definition).toEqual(before);
  const compressed=landmarks.map(p=>({...p,y:50+(p.y-50)*0.4}));expect(fitMapLandmarks(definition,compressed,frame).healthy).toBe(false);
});
