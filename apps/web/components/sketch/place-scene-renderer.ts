import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { buildStreetComponent } from "./street-components";
import { stoneTexture } from "./street-texture";
import { buildStructuredBuilding } from "./structured-building";
import { parseBuildingStructure } from "@/lib/building-structure";
import { resolveSceneObject } from "@/lib/floor-placement";
import { addRoomLabels } from "./room-labels";
import type { Solid } from "@/lib/place-physics";
export type { Solid } from "@/lib/place-physics";

export function buildPlaceScene(def: PlaceSceneDefinition, options: { eaveHeights?: Record<string, number>; cutaway?: boolean; ground?: boolean; floorId?: string | undefined } = {}) {
  for (const object of def.objects) if (object.kind === "building") parseBuildingStructure(object);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dce8e7");
  scene.add(new THREE.HemisphereLight(0xf1fbff, 0x6d806a, 2.4));
  const sun = new THREE.DirectionalLight(0xfff4da, 3);
  sun.position.set(-8, 18, 6); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 0.1, far: 140 });
  sun.shadow.normalBias = 0.025; scene.add(sun);
  const solids: Solid[] = [];
  function box(group: THREE.Group | THREE.Scene, x: number, y: number, z: number, w: number, h: number, d: number, color: string, o?: PlaceSceneObject, solid = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    if (o) mesh.userData.objectId = o.id;
    if (solid) {
      const a = o?.heading ?? 0, c = Math.cos(a), s = Math.sin(a);
      solids.push({ x: (o?.x ?? 0) + x * c - z * s, y: y + group.position.y, z: (o?.z ?? 0) + x * s + z * c, w, h, d, yaw: -a });
    }
    return mesh;
  }
  const street = def.objects.some(o => o.kind === "tavern" || o.kind === "house");
  if(options.ground!==false){
    const ground = box(scene, def.width / 2, -0.12, def.depth / 2, def.width, 0.24, def.depth, street ? "#b6beb1" : "#88a980");
    ground.userData.groundSurface = true;
    if (street) ground.userData.surface = "stone";
    if (street) (ground.material as THREE.MeshStandardMaterial).map = stoneTexture(def.width, def.depth);
  }
  for (const original of def.objects) {
    const o = resolveSceneObject(def, original);
    const group = new THREE.Group(); group.position.set(o.x, o.elevation, o.z); group.rotation.y = -o.heading;
    group.userData.sceneObjectId = o.id;
    if (o.placement && (options.cutaway || options.floorId)) group.visible = o.placement.floor_id === options.floorId;
    scene.add(group);
    if (o.kind === "building") {
      const floor = o.structure!.floors.findIndex(f => f.id === options.floorId);
      buildStructuredBuilding(o, group, solids, !!options.cutaway || floor >= 0, Math.max(0, floor));
      if (o.asset_id) { group.userData.meshObjectId = o.id; group.userData.hideMesh = !!options.cutaway || floor >= 0; }
      if (options.cutaway) addRoomLabels(group, o, Math.max(0, floor));
      continue;
    }
    if (o.kind === "mesh") {
      group.userData.meshObjectId = o.id;
      solids.push({ x: o.x, y: o.elevation + o.height / 2, z: o.z, w: o.width, h: o.height, d: o.depth, yaw: -o.heading });
      continue;
    }
    const b = (x: number, y: number, z: number, w: number, h: number, d: number, color = o.color, solid = true) => box(group, x, y, z, w, h, d, color, o, solid);
    if (buildStreetComponent(o, group, b, options.eaveHeights?.[o.id])) continue;
    if (o.kind === "pond") {
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.1, 48), new THREE.MeshStandardMaterial({ color: "#a5b1ac", roughness: 1 }));
      rim.scale.set(o.width / 2, 1, o.depth / 2); rim.position.y = 0.05; rim.userData.objectId = o.id; group.add(rim);
      const water = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.22, metalness: 0.25 }));
      water.rotation.x = -Math.PI / 2; water.scale.set(o.width / 2 - 0.16, o.depth / 2 - 0.16, 1); water.position.y = 0.11; water.userData.objectId = o.id; group.add(water);
      // The water is not traversable; the conservative footprint is intentional.
      solids.push({ x: o.x, y: 0.4, z: o.z, w: o.width, h: 0.8, d: o.depth, yaw: -o.heading });
    } else if (o.kind === "bench") {
      const seat = o.height * 0.5;
      for (const x of [-o.width * 0.35, o.width * 0.35]) b(x, seat / 2, 0, 0.12, seat, o.depth * 0.8, "#465555");
      for (let i = 0; i < 4; i++) b(0, seat, -o.depth / 2 + (i + 0.5) * o.depth / 4, o.width, 0.09, o.depth / 4 - 0.025);
      for (const x of [-o.width * 0.4, o.width * 0.4]) b(x, o.height * 0.72, o.depth * 0.42, 0.07, o.height * 0.55, 0.07, "#465555");
      b(0, o.height * 0.82, o.depth * 0.42, o.width, o.height * 0.25, 0.09);
    } else if (o.kind === "pergola") {
      for (const x of [-1, 1]) for (const z of [-1, 1]) b(x * (o.width / 2 - 0.12), o.height / 2, z * (o.depth / 2 - 0.12), 0.18, o.height, 0.18);
      for (const z of [-1, 1]) b(0, o.height, z * (o.depth / 2 - 0.12), o.width, 0.18, 0.18);
      const count = Math.max(3, Math.ceil(o.width / 0.4));
      for (let i = 0; i < count; i++) b(-o.width / 2 + 0.12 + i * (o.width - 0.24) / (count - 1), o.height + 0.12, 0, 0.12, 0.16, o.depth);
    } else if (o.kind === "tree") {
      b(0, o.height * 0.3, 0, 0.2, o.height * 0.6, 0.2, "#746259");
      const leaves = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: o.color, roughness: 1, flatShading: true }));
      leaves.scale.set(o.width / 2, o.height * 0.36, o.depth / 2); leaves.position.y = o.height * 0.65; leaves.castShadow = true; leaves.userData.objectId = o.id; group.add(leaves);
    } else {
      const slab = b(0, o.height / 2, 0, o.width, o.height, o.depth, o.color, o.kind !== "path");
      if (o.kind === "path") slab.userData.materialSurface = "floor";
      if (street && o.kind === "path") slab.userData.surface = "stone";
      if (street && o.kind === "path") (slab.material as THREE.MeshStandardMaterial).map = stoneTexture(o.width, o.depth);
      if (o.kind === "wall") b(0, o.height + 0.03, 0, o.width, 0.06, o.depth + 0.06, "#c0cbca", false);
    }
  }
  return { scene, solids };
}

export function disposePlace(scene: THREE.Scene) {
  const disposedTextures = new Set<THREE.Texture>();
  scene.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
      if (!(object instanceof THREE.Sprite)) object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const texture of Object.values(material)) {
          if (texture instanceof THREE.Texture && !disposedTextures.has(texture)) { texture.dispose(); disposedTextures.add(texture); }
        }
        material.dispose();
      }
    }
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
  });
}
export { THREE, OrbitControls };
