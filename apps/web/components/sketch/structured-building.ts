import * as THREE from "three";
import type { PlaceSceneObject } from "@openflipbook/config";
import { buildingParts, buildingStair, storeyHeight } from "@/lib/building-structure";
import type { Solid } from "@/lib/place-physics";
import { buildingEnvelope } from "@/lib/building-footprint";

export function buildStructuredBuilding(object: PlaceSceneObject, group: THREE.Group, solids: Solid[], cutaway: boolean, visibleFloor = 0) {
  const structure = object.structure!, level = storeyHeight(object);
  const materials = {
    wall: new THREE.MeshStandardMaterial({color: object.color, roughness: 0.88}),
    floor: new THREE.MeshStandardMaterial({color: "#8b795f", roughness: 0.92}),
    stair: new THREE.MeshStandardMaterial({color: "#756850", roughness: 0.85}),
    glass: new THREE.MeshStandardMaterial({color: "#78a8b0", transparent: true, opacity: 0.3, roughness: 0.22, metalness: 0.1}),
    ceiling: new THREE.MeshStandardMaterial({color: "#e0d9c9", roughness: 0.92}),
  };
  if (object.asset_id) for (const material of Object.values(materials)) {
    material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1;
  }
  for (const part of buildingParts(object)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(part.w, part.h, part.d), materials[part.surface]);
    mesh.position.set(part.x, part.y, part.z); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.objectId = object.id; mesh.userData.surface = part.surface; mesh.userData.structuredBuilding = true;
    if (part.partition_id) { mesh.userData.partitionId = part.partition_id; mesh.userData.floor = part.floor; }
    if (cutaway && (part.surface === "ceiling" || (part.surface === "floor" && part.y > visibleFloor * level))) mesh.visible = false;
    if (cutaway && part.floor !== undefined && (part.floor !== visibleFloor || part.y - part.h / 2 > part.floor * level + 0.1)) mesh.visible = false;
    group.add(mesh);
    const c = Math.cos(object.heading), s = Math.sin(object.heading);
    if (part.surface !== "stair") solids.push({x: object.x + part.x*c-part.z*s, y: part.y, z: object.z + part.x*s+part.z*c, w: part.w, h: part.h, d: part.d, yaw: -object.heading});
  }
  if (structure.floors.length === 2) {
    // The capsule follows a continuous stair ramp; visible treads retain the
    // same flight dimensions without snagging on each short tread edge.
    const stair = buildingStair(object), c = Math.cos(object.heading), s = Math.sin(object.heading);
    solids.push({x:object.x+stair.x*c-stair.z*s,y:level/2,z:object.z+stair.x*s+stair.z*c,w:stair.width,h:level,d:stair.run,yaw:-object.heading-stair.heading,ramp:true});
  }
  const roofRects = structure.footprint ? buildingEnvelope(object).roofRects : [{ x1: -object.width / 2, x2: object.width / 2, z1: -object.depth / 2, z2: object.depth / 2 }];
  for (const r of object.asset_id ? [] : roofRects) {
  const w = (r.x2 - r.x1)/2, d = (r.z2 - r.z1)/2, eave = object.height-structure.roof_height;
  const roofGeometry = new THREE.BufferGeometry();
  roofGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-w,eave,-d, w,eave,-d, 0,object.height,-d, -w,eave,d, w,eave,d, 0,object.height,d],3));
  roofGeometry.setIndex([0,2,1,3,4,5,0,3,5,0,5,2,1,2,5,1,5,4]);
  // Separate face normals: averaging the gables into the slopes makes a flat
  // roof look curved and creates self-shadow striping along the ridge.
  const facetedRoof = roofGeometry.toNonIndexed(); roofGeometry.dispose(); facetedRoof.computeVertexNormals();
  const roof = new THREE.Mesh(facetedRoof, new THREE.MeshStandardMaterial({color:"#597b76",roughness:0.85,side:THREE.DoubleSide}));
  roof.position.set((r.x1 + r.x2) / 2, 0, (r.z1 + r.z2) / 2);
  roof.visible = !cutaway; roof.castShadow = true; roof.receiveShadow = true; roof.userData.objectId = object.id; roof.userData.structuredBuilding = true; roof.userData.surface = "roof"; group.add(roof);
  }
  const lightPoints = structure.footprint ? [...buildingEnvelope(object).floorRects].sort((a, b) => (b.x2 - b.x1) * (b.z2 - b.z1) - (a.x2 - a.x1) * (a.z2 - a.z1)).slice(0, 8).map(r => ({ x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2 })) : [{ x: 0, z: 0 }];
  for (let floor = 0; floor < structure.floors.length; floor++) for (const point of lightPoints) {
    const light = new THREE.PointLight(0xffe3ad, 9 / lightPoints.length, Math.max(object.width,object.depth)*1.5, 2);
    light.position.set(point.x, floor*level+level-0.35,point.z); group.add(light);
  }
}
