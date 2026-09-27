import { expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { newComponent } from "./place-scene";
import { objectCameraFrame } from "./object-camera-frame";

it.each(["north", "east", "south", "west"] as const)("faces the saved %s doorway even after rotation", side => {
  const object = {...newComponent("building", 20, 30),elevation:0};
  object.structure!.door.side = side; object.heading = 0.73;
  const { target, position } = objectCameraFrame(object, 60, 16 / 9);
  const local = position.clone().sub(target).applyAxisAngle(new Vector3(0, 1, 0), object.heading);
  const normals = {north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]};
  const normal = normals[side];
  expect(local.x * normal[0]! + local.z * normal[1]!).toBeGreaterThan(0);
  expect(Math.abs(local.x * normal[1]! - local.z * normal[0]!)).toBeLessThan((local.x * normal[0]! + local.z * normal[1]!) * 0.5);
});
it.each([16/9, 1, 0.35])("fits all bounds at aspect %s without changing geometry", aspect => {
  const object = {...newComponent("building", 20, 30),width:24,height:12,depth:16,elevation:4,heading:1.3};
  const before = structuredClone(object), framed = objectCameraFrame(object, 60, aspect);
  const camera = new PerspectiveCamera(60, aspect, 0.05, 500);
  camera.position.copy(framed.position); camera.lookAt(framed.target); camera.updateMatrixWorld();
  for (const x of [-1,1]) for (const y of [0,1]) for (const z of [-1,1]) {
    const p = new Vector3(x*object.width/2,y*object.height,z*object.depth/2).applyAxisAngle(new Vector3(0,1,0),-object.heading).add(new Vector3(object.x,object.elevation,object.z)).project(camera);
    expect(Math.abs(p.x)).toBeLessThan(0.9); expect(Math.abs(p.y)).toBeLessThan(0.9); expect(p.z).toBeLessThan(1); expect(p.z).toBeGreaterThan(-1);
  }
  expect(object).toEqual(before);
});
it("supports non-architectural objects and rejects invalid projection values", () => {
  const object = {...newComponent("tree", 2, 3),elevation:0};
  expect(objectCameraFrame(object, 60, 1).distance).toBeGreaterThan(2);
  for (const aspect of [0,-1,NaN,Infinity]) expect(()=>objectCameraFrame(object,60,aspect)).toThrow("Invalid camera");
});
