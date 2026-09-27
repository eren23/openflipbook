import { describe, expect, it, vi } from "vitest";
import type { BuildingSide, PlaceConnection, PlaceSceneSnapshot } from "@openflipbook/config";
import { adjacentPlacement, networkBoundarySolids, networkPlaceAt, networkView, placeFrame, placeNetwork, validatePlaceConnection } from "./place-connections";
import { emptyPlaceScene, newComponent, sceneGeos } from "./place-scene";
import { buildConnectedPlaces } from "../components/sketch/connected-place-renderer";
import { disposePlace } from "../components/sketch/place-scene-renderer";
import { loadPlacePhysics } from "./place-physics";
import { placeCollider } from "./place-colliders";
vi.mock("@dimforge/rapier3d-compat",async()=>{
  // @ts-expect-error The browser entry shares declarations with the package root.
  const m=await import("@dimforge/rapier3d-compat/rapier.es.js");return {default:m.default};
});
const scene=(id:string):PlaceSceneSnapshot=>({id,place_id:id,session_id:"world",revision:1,source_node_id:null,source_image_key:null,updated_at:new Date(0).toISOString(),definition:{...emptyPlaceScene(),label:id,width:20,depth:20,entrance:{x:10,z:10,yaw:0}}});
function fixture(side:BuildingSide="east"){
  const a=scene("a"),b=scene("b"),geos=sceneGeos(a,[]);
  geos.push(adjacentPlacement(a,b,side,geos));
  const c:PlaceConnection={id:"connection",version:1,kind:"boundary",a:{place_id:"a",side,offset:10},b:{place_id:"b",side:({north:"south",south:"north",east:"west",west:"east"} as const)[side],offset:10},width:3,created_at:new Date(0).toISOString()};
  return {a,b,geos,c};
}
describe("connected place geometry",()=>{
  it.each(["north","east","south","west"] as const)("aligns opposite %s boundaries and retains source placement",side=>{
    const {a,b,geos,c}=fixture(side),before=structuredClone(geos[0]);
    expect(()=>validatePlaceConnection(c,[a,b],geos)).not.toThrow();
    expect(geos[0]).toEqual(before);
    const network=placeNetwork("a",[a,b],geos,[c])!,view=networkView(network,"a");
    expect(view.definition.width).toBe(side==="east"||side==="west"?40:20);
    expect(view.definition.depth).toBe(side==="north"||side==="south"?40:20);
    expect(networkPlaceAt(view.chunks,view.definition.entrance.x,view.definition.entrance.z)).toBe("a");
    expect(view.chunks.map(c=>c.scene.id)).toEqual(["a","b"]);
  });
  it("does not treat image-scale, nested, rotated or raised frames as continuous ground",()=>{
    const {a,geos}=fixture();
    for(const patch of [{scale:0.5},{parent_id:"parent"},{heading:0.5},{elevation:2},{footprint:{w:10,d:20}},{heading:NaN},{elevation:Infinity},{scale:NaN},{footprint:{w:NaN,d:20}}])expect(()=>placeFrame(a,[{...geos[0]!,...patch}])).toThrow("authored metres");
  });
  it("rejects missing scenes, moved boundaries, outside openings and blocked approaches",()=>{
    const {a,b,geos,c}=fixture();
    expect(()=>validatePlaceConnection(c,[a],geos)).toThrow("missing");
    expect(()=>validatePlaceConnection({...c,width:30},[a,b],geos)).toThrow("Invalid");
    expect(()=>validatePlaceConnection({...c,a:{...c.a,offset:0}},[a,b],geos)).toThrow("beyond");
    const moved=structuredClone(geos);moved[1]!.pos.x+=1;
    expect(()=>validatePlaceConnection(c,[a,b],moved)).toThrow("align");
    a.definition.objects.push({...newComponent("wall",19.8,10),width:4,depth:0.3,heading:Math.PI/2});
    expect(()=>validatePlaceConnection(c,[a,b],geos)).toThrow("blocked");
  });
  it("rejects overlapping expansion and leaves disconnected scenes unloaded",()=>{
    const {a,b,geos,c}=fixture();
    expect(()=>adjacentPlacement(a,scene("third"),"east",geos)).toThrow("overlaps");
    expect(placeNetwork("isolated",[a,b,scene("isolated")],geos,[c])).toBeNull();
    expect(placeNetwork("a",[a,b,scene("isolated")],geos,[c])!.chunks).toHaveLength(2);
  });
  it("rejects inherited object keys as boundary directions",()=>{
    const {a,b,geos,c}=fixture();
    for(const side of ["constructor","toString","__proto__"]){
      expect(()=>adjacentPlacement(a,b,side as BuildingSide,geos)).toThrow("direction");
      expect(()=>validatePlaceConnection({...c,a:{...c.a,side:side as BuildingSide}},[a,b],geos)).toThrow("Invalid");
    }
  });
  it("leaves only the registered passage open on the shared boundary",()=>{
    const {a,b,geos,c}=fixture(),view=networkView(placeNetwork("a",[a,b],geos,[c])!,"a");
    const boundaries=networkBoundarySolids(view.chunks,[c]);
    const blocked=(x:number,z:number)=>boundaries.some(b=>Math.abs(b.x-x)<b.w/2&&Math.abs(b.z-z)<b.d/2);
    expect(blocked(20,10)).toBe(false);expect(blocked(20,4)).toBe(true);expect(blocked(0,10)).toBe(true);
  });
  it("uses real Rapier collision for crossing, returning and blocking unconnected edges",async()=>{
    const {a,b,geos,c}=fixture(),network=placeNetwork("a",[a,b],geos,[c])!,built=buildConnectedPlaces(network,"a"),R=await loadPlacePhysics();
    const world=new R.World({x:0,y:-9.81,z:0});
    try{
      for(const s of built.solids)world.createCollider(placeCollider(R,s));
      const body=world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(19,0.82,10));
      const collider=world.createCollider(R.ColliderDesc.capsule(0.5,0.3),body),controller=world.createCharacterController(0.02);
      world.step();
      const move=(x:number,z:number,n:number)=>{for(let i=0;i<n;i++){controller.computeColliderMovement(collider,{x,y:-0.01,z});const p=body.translation(),d=controller.computedMovement();body.setNextKinematicTranslation({x:p.x+d.x,y:p.y+d.y,z:p.z+d.z});world.step();}};
      move(0.04,0,80);expect(body.translation().x).toBeGreaterThan(22);expect(networkPlaceAt(built.chunks,body.translation().x,body.translation().z)).toBe("b");
      move(-0.04,0,80);expect(body.translation().x).toBeLessThan(20);
      move(0,-0.04,150);move(0.04,0,100);expect(body.translation().x).toBeLessThan(19.7);
    }finally{world.free();disposePlace(built.scene);}
  });
});
