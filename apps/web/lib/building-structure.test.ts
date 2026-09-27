import {describe, expect, it, vi} from "vitest";
import type {PlaceSceneDefinition} from "@openflipbook/config";
import {buildingBlocksPoint, buildingParts, buildingStair, parseBuildingStructure, storeyHeight} from "./building-structure";
import {gardenScene, newComponent, parsePlaceScene, sceneGeos} from "./place-scene";
import {buildPlaceScene, disposePlace, THREE} from "../components/sketch/place-scene-renderer";
import {loadPlacePhysics} from "./place-physics";
import {placeCollider} from "./place-colliders";
// Match Next's browser entry; Rapier 0.17's Node main is CJS in a type:module package.
vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error The bundled browser entry uses the package-root declarations.
  const rapierModule = await import("@dimforge/rapier3d-compat/rapier.es.js");
  return {default: rapierModule.default};
});

function definition(two = false): PlaceSceneDefinition {
  const b = newComponent("building",10,10);
  if (two) {b.structure!.floors.push({id:"upper",label:"Upper room"}); b.height=7.8;}
  return {...gardenScene(),version:2,objects:[b]};
}
describe("structured building contract",()=>{
  it("preserves legacy scenes and requires explicit v2 for architecture",()=>{
    const old=gardenScene(); expect(parsePlaceScene(old)).toEqual(old);
    const next=definition(); expect(parsePlaceScene(next)).toEqual(next);
    expect(()=>parsePlaceScene({...next,version:1})).toThrow("version 2");
    old.objects[0]!.structure=next.objects[0]!.structure!;
    expect(()=>parsePlaceScene(old)).toThrow("Only structured buildings");
  });
  it("creates a real doorway, closed wall and traversable interior",()=>{
    const b=definition().objects[0]!;
    expect(buildingBlocksPoint(b,{x:10,z:14.5})).toBe(false);
    expect(buildingBlocksPoint(b,{x:12,z:14.5})).toBe(true);
    expect(buildingBlocksPoint(b,{x:10,z:10})).toBe(false);
    expect(buildingBlocksPoint(b,{x:10,z:5.5})).toBe(true);
    const d=definition();d.entrance={x:10,z:10,yaw:0}; expect(()=>parsePlaceScene(d)).not.toThrow();
  });
  it("keeps rotated architecture, collision and map identity aligned",()=>{
    const d=definition(), b=d.objects[0]!;b.heading=Math.PI/2;
    expect(buildingBlocksPoint(b,{x:5.5,z:10})).toBe(false);
    expect(buildingBlocksPoint(b,{x:5.5,z:12})).toBe(true);
    const geos=sceneGeos({id:"scene",session_id:"world",place_id:"place",revision:1,definition:d,source_node_id:"source",source_image_key:"key",updated_at:"now"},[]);
    expect(geos.find(g=>g.id===b.id)).toMatchObject({kind:"place",entity_id:b.entity_id,heading:Math.PI/2});
  });
  it("rejects invalid openings, duplicate ids and intersecting windows",()=>{
    const b=definition().objects[0]!, base=structuredClone(b.structure!);
    b.structure!.door.width=0.5;expect(()=>parseBuildingStructure(b)).toThrow("clearance");
    b.structure=structuredClone(base);b.structure.windows[0]!.side="south";expect(()=>parseBuildingStructure(b)).toThrow("overlap");
    b.structure=structuredClone(base);b.structure.windows[0]!.id=b.structure.door.id;expect(()=>parseBuildingStructure(b)).toThrow("identity");
    b.structure=structuredClone(base);b.structure.door.sill=0.1;expect(()=>parseBuildingStructure(b)).toThrow("ground floor");
  });
  it("requires space for stairs and preserves upper-floor aperture",()=>{
    const d=definition(true), b=d.objects[0]!, stair=buildingStair(b), level=storeyHeight(b);
    expect(()=>parsePlaceScene(d)).not.toThrow();
    expect(buildingParts(b).filter(p=>p.surface==="stair")).toHaveLength(stair.steps);
    const floors=buildingParts(b).filter(p=>p.surface==="floor"&&p.y>0);
    expect(floors.some(p=>Math.abs(p.x-stair.x)<p.w/2&&Math.abs(p.z-stair.z)<p.d/2)).toBe(false);
    expect(floors.every(p=>Math.abs(p.y+p.h/2-level)<1e-8)).toBe(true);
    b.depth=5;expect(()=>parseBuildingStructure(b)).toThrow("too shallow");
  });
  it("does not allow two buildings to share floor or opening identities",()=>{
    const d=definition(), b=d.objects[0]!, copy={...structuredClone(b),id:"other",entity_id:"other_entity"};
    d.objects.push(copy);expect(()=>parsePlaceScene(d)).toThrow("another building");
  });
  it("hides roof and upper slab only in plan, without changing collision",()=>{
    const d=definition(true), full=buildPlaceScene(d), plan=buildPlaceScene(d,{cutaway:true});
    expect(plan.solids).toEqual(full.solids);
    let visibleRoof=0, hiddenRoof=0;
    full.scene.traverse(o=>{if(o.userData.surface==="roof"&&o.visible)visibleRoof++;});
    plan.scene.traverse(o=>{if(o.userData.surface==="roof"&&!o.visible)hiddenRoof++;});
    expect(visibleRoof).toBe(1);expect(hiddenRoof).toBe(1);disposePlace(full.scene);disposePlace(plan.scene);
  });
  it("keeps roof faces flat-shaded without changing their authored envelope",()=>{
    const d=definition(), built=buildPlaceScene(d);
    built.scene.traverse(o=>{
      if (!(o instanceof THREE.Mesh) || o.userData.surface!=="roof") return;
      const normals=o.geometry.getAttribute("normal"), positions=o.geometry.getAttribute("position");
      expect(o.geometry.index).toBeNull();
      for(let i=0;i<normals.count;i+=3) for(let j=1;j<3;j++) {
        expect([normals.getX(i+j),normals.getY(i+j),normals.getZ(i+j)]).toEqual([normals.getX(i),normals.getY(i),normals.getZ(i)]);
      }
      expect(Math.max(...Array.from({length:positions.count},(_,i)=>positions.getY(i)))).toBeCloseTo(d.objects[0]!.height);
    });
    disposePlace(built.scene);
  });
  it("walks real Rapier collision through the door and up the stair flight",async()=>{
    const d=definition(true), b=d.objects[0]!, built=buildPlaceScene(d), R=await loadPlacePhysics();
    const world=new R.World({x:0,y:-9.81,z:0});
    try {
      for(const p of built.solids)world.createCollider(placeCollider(R,p));
      const body=world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(10,0.82,16));
      const collider=world.createCollider(R.ColliderDesc.capsule(0.5,0.3),body), controller=world.createCharacterController(0.02);
      controller.enableSnapToGround(0.2);controller.enableAutostep(0.25,0.2,false);controller.setSlideEnabled(true);world.step();
      let vy=0;
      const move=(x:number,z:number,steps:number)=>{for(let i=0;i<steps;i++){const p=body.translation();vy=controller.computedGrounded()?-0.2:Math.max(-20,vy-9.81/60);controller.computeColliderMovement(collider,{x,y:vy/60,z});const delta=controller.computedMovement();body.setNextKinematicTranslation({x:p.x+delta.x,y:Math.max(0.82,p.y+delta.y),z:p.z+delta.z});world.timestep=1/60;world.step();}};
      move(0,-0.04,90);expect(body.translation().z).toBeLessThan(13);
      const stair=buildingStair(b);move(-0.04,0,Math.round((10-(b.x+stair.x))/0.04));
      move(0,-0.04,300);
      expect(body.translation().y, JSON.stringify(body.translation())).toBeGreaterThan(storeyHeight(b)+0.75);
      expect(body.translation().z).toBeLessThan(b.z+stair.point(0, -stair.run / 2).z);
      move(0,-0.04,100);expect(body.translation().z).toBeGreaterThan(5.7);
    } finally {world.free();disposePlace(built.scene);}
  });
  it("retains the exact legacy flight unless the user authors a placement", () => {
    const d = definition(true), b = d.objects[0]!, before = buildingParts(b), flight = buildingStair(b);
    expect(parsePlaceScene(d).objects[0]!.structure).not.toHaveProperty("stair");
    b.structure!.stair = { id: "stair", x: flight.x, z: flight.z, direction: "north" };
    const after = buildingParts(b); expect(after).toEqual(before);
    expect(parsePlaceScene(d).objects[0]!.structure!.stair).toEqual(b.structure!.stair);
  });
  it.each(["north", "east", "south", "west"] as const)("aligns %s treads, slab aperture and rotated ramp", direction => {
    const d = definition(true), b = d.objects[0]!; b.width = b.depth = 12; b.heading = 0.4;
    b.structure!.stair = { id: "flight", x: 1, z: 0, direction };
    expect(() => parsePlaceScene(d)).not.toThrow();
    const stair = buildingStair(b), parts = buildingParts(b), floors = parts.filter(p => p.surface === "floor" && p.y > 0);
    const hole = stair.bounds();
    for (const p of floors) {
      const overlapX = Math.max(0, Math.min(p.x + p.w / 2, hole.x2) - Math.max(p.x - p.w / 2, hole.x1));
      const overlapZ = Math.max(0, Math.min(p.z + p.d / 2, hole.z2) - Math.max(p.z - p.d / 2, hole.z1));
      expect(overlapX * overlapZ).toBeLessThan(1e-10);
    }
    const treads = parts.filter(p => p.surface === "stair");
    expect(treads).toHaveLength(stair.steps);
    const top = treads.at(-1)!, point = stair.point(0, -stair.run / 2 + 0.125);
    expect(top.x).toBeCloseTo(point.x); expect(top.z).toBeCloseTo(point.z); expect(top.y + top.h / 2).toBeCloseTo(stair.level);
    const built = buildPlaceScene(d), ramp = built.solids.find(p => p.ramp)!;
    expect(ramp.x).toBeCloseTo(b.x + stair.x * Math.cos(b.heading) - stair.z * Math.sin(b.heading));
    expect(ramp.z).toBeCloseTo(b.z + stair.x * Math.sin(b.heading) + stair.z * Math.cos(b.heading));
    expect(ramp.yaw).toBeCloseTo(-b.heading - stair.heading); disposePlace(built.scene);
  });
  it.each(["bounds", "direction", "identity", "floor"])("rejects invalid authored stair %s", reason => {
    const d = definition(true), b = d.objects[0]!;
    b.structure!.stair = { id: "flight", x: 0, z: 0, direction: "north" };
    if (reason === "bounds") b.structure!.stair.x = 3.5;
    if (reason === "direction") b.structure!.stair.direction = "diagonal" as never;
    if (reason === "identity") b.structure!.stair.id = b.structure!.door.id;
    if (reason === "floor") { b.structure!.floors.pop(); b.height = 4.6; }
    expect(() => parsePlaceScene(d)).toThrow();
  });
  it.each(["north", "east", "south", "west"] as const)("climbs and descends the moved %s flight through real Rapier collision", async direction => {
    const d = definition(true), b = d.objects[0]!; b.width = b.depth = 12; b.heading = 0.35;
    b.structure!.stair = { id: "flight", x: 0.6, z: -0.3, direction };
    const stair = buildingStair(b), built = buildPlaceScene(d), R = await loadPlacePhysics(), world = new R.World({ x: 0, y: -9.81, z: 0 });
    const c = Math.cos(b.heading), s = Math.sin(b.heading), start = stair.point(0, stair.run / 2 + 0.55);
    const worldPoint = (p: { x: number; z: number }) => ({ x: b.x + p.x * c - p.z * s, z: b.z + p.x * s + p.z * c });
    try {
      for (const solid of built.solids) world.createCollider(placeCollider(R, solid));
      const p = worldPoint(start), body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.82, p.z));
      const collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.3), body), controller = world.createCharacterController(0.02);
      controller.enableSnapToGround(0.2); controller.enableAutostep(0.25, 0.2, false); controller.setSlideEnabled(true); world.step();
      const vector = stair.point(0, -0.035), dx = vector.x - stair.x, dz = vector.z - stair.z;
      let vy = 0;
      const move = (sign: number, count: number) => { for (let i = 0; i < count; i++) {
        const old = body.translation(); vy = controller.computedGrounded() ? -0.2 : Math.max(-20, vy - 9.81 / 60);
        controller.computeColliderMovement(collider, { x: sign * (dx * c - dz * s), y: vy / 60, z: sign * (dx * s + dz * c) });
        const delta = controller.computedMovement(); body.setNextKinematicTranslation({ x: old.x + delta.x, y: old.y + delta.y, z: old.z + delta.z }); world.timestep = 1 / 60; world.step();
      } };
      const landing = worldPoint(stair.point(0, -stair.run / 2 - 0.45));
      const distance = (target: { x: number; z: number }) => Math.hypot(body.translation().x - target.x, body.translation().z - target.z);
      // Rapier projects requested movement onto the ramp; elapsed frames are
      // not a linear distance estimate. Stop only at the actual landing.
      for (let i = 0; i < 600 && distance(landing) > 0.08; i++) move(1, 1);
      expect(distance(landing)).toBeLessThan(0.08);
      expect(body.translation().y, JSON.stringify(body.translation())).toBeGreaterThan(stair.level + 0.75);
      for (let i = 0; i < 600 && distance(p) > 0.08; i++) move(-1, 1);
      expect(distance(p)).toBeLessThan(0.08);
      move(0, 30);
      expect(body.translation().y).toBeLessThan(0.9);
    } finally { world.free(); disposePlace(built.scene); }
  });
});
