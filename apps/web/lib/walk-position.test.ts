import {describe,expect,it,vi} from "vitest";
import {parseWalkPose,parseWalkWrite,poseInsidePlace,poseSpaceMatches,walkSpace,wrapYaw,type WalkPose} from "./walk-position";
import {walkPositionClear} from "./walk-position-physics";
import {loadPlacePhysics} from "./place-physics";
import {placeCollider} from "./place-colliders";
import {buildPlaceScene,disposePlace} from "../components/sketch/place-scene-renderer";
import {emptyPlaceScene,newComponent} from "./place-scene";
import {storeyHeight} from "./building-structure";
vi.mock("@dimforge/rapier3d-compat",async()=>{
  // @ts-expect-error Browser bundle shares declarations with the root package.
  const m=await import("@dimforge/rapier3d-compat/rapier.es.js");return {default:m.default};
});
const pose:WalkPose={version:1,place_id:"place",scene_revision:1,position:{x:10,y:0.82,z:16},yaw:0,pitch:0};
describe("saved walking position",()=>{
  it("validates finite local coordinates and strips extra fields",()=>{
    expect(parseWalkPose({...pose,secret:"ignored"})).toEqual(pose);
    for(const patch of [{version:2},{scene_revision:0},{scene_revision:1.5},{place_id:"../bad"},{yaw:NaN},{yaw:20},{pitch:2},{position:{x:1,y:Infinity,z:2}},{position:{x:-1,y:1,z:2}}])expect(parseWalkPose({...pose,...patch})).toBeNull();
    expect(poseInsidePlace(pose,{...emptyPlaceScene(),width:9})).toBe(false);
    expect(wrapYaw(8*Math.PI)).toBeCloseTo(0);
  });
  it("requires a revision and UUID request identity",()=>{
    const write={request_id:crypto.randomUUID(),base_revision:0,pose};
    expect(parseWalkWrite(write)).toEqual(write);
    expect(parseWalkWrite({...write,base_revision:-1})).toBeNull();
    expect(parseWalkWrite({...write,request_id:"bad"})).toBeNull();
  });
  it("retains building/floor identity instead of accepting a replacement roof",()=>{
    const b=newComponent("building",10,10);b.structure!.floors.push({id:"upper",label:"Upper"});b.height=7.8;
    const d={...emptyPlaceScene(),objects:[b]},position={x:11,y:4.02,z:10},space=walkSpace(d,position);
    expect(space).toEqual({building_id:b.id,floor_id:"upper"});
    const saved={...pose,position,space};expect(poseSpaceMatches(saved,d)).toBe(true);
    b.color="#123456";expect(poseSpaceMatches(saved,d)).toBe(true);
    b.structure!.floors.pop();b.height=4.6;expect(poseSpaceMatches(saved,d)).toBe(false);
    expect(parseWalkPose({...saved,space:{building_id:"../bad",floor_id:"upper"}})).toBeNull();
  });
  it("checks actual wall clearance, support and upper floors using Rapier",async()=>{
    const b=newComponent("building",10,10);b.structure!.floors.push({id:"upper",label:"Upper"});b.height=7.8;
    const built=buildPlaceScene({...emptyPlaceScene(),objects:[b]}),R=await loadPlacePhysics(),world=new R.World({x:0,y:-9.81,z:0});
    try{
      for(const solid of built.solids)world.createCollider(placeCollider(R,solid));world.step();
      expect(walkPositionClear(R,world,pose.position)).toBe(true);
      expect(walkPositionClear(R,world,{x:12,y:0.9,z:14.5})).toBe(false);
      expect(walkPositionClear(R,world,{x:2,y:3,z:2})).toBe(false);
      expect(walkPositionClear(R,world,{x:11,y:storeyHeight(b)+0.82,z:10})).toBe(true);
      expect(walkPositionClear(R,world,{x:11,y:storeyHeight(b)+0.4,z:10})).toBe(false);
      const body=world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(10,0.82,16));
      const collider=world.createCollider(R.ColliderDesc.capsule(0.5,0.3),body);world.step();
      expect(walkPositionClear(R,world,pose.position,collider)).toBe(true);
      expect(walkPositionClear(R,world,pose.position)).toBe(false);
      body.setTranslation({x:7.05,y:0.82,z:12.4},true);world.step();
      const controller=world.createCharacterController(0.02);controller.enableSnapToGround(0.2);controller.enableAutostep(0.25,0.2,false);
      for(let i=0;i<120;i++){
        controller.computeColliderMovement(collider,{x:0,y:-0.02,z:-0.04});
        const p=body.translation(),d=controller.computedMovement();body.setNextKinematicTranslation({x:p.x+d.x,y:p.y+d.y,z:p.z+d.z});world.step();
      }
      expect(body.translation().y).toBeGreaterThan(1.5);expect(body.translation().y).toBeLessThan(storeyHeight(b)+0.8);
      expect(walkPositionClear(R,world,body.translation(),collider)).toBe(true);
    }finally{world.free();disposePlace(built.scene);}
  });
});
