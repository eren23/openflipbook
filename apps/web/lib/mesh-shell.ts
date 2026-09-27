import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { buildingParts, newBuildingStructure, parseBuildingStructure } from "./building-structure";
import { polygonRects, rectPolygon } from "./building-footprint";
import { parsePlaceScene } from "./place-scene";

export function proposeMeshShell(scene: PlaceSceneDefinition, id: string) {
  const source = scene.objects.find(o => o.id === id);
  if (source?.kind !== "mesh" || !source.asset_id || source.placement) throw new Error("Select an outdoor mesh for a structural shell");
  const { mesh_role: _role, ...object } = source;
  const structure = newBuildingStructure();
  structure.windows = [];
  if (source.height >= 5.5) structure.floors.push({ id: crypto.randomUUID(), label: "Upper floor" });
  structure.roof_height = Math.max(0.3, Math.min(4, source.height - 3.2 * structure.floors.length));
  const next: PlaceSceneObject = { ...object, kind: "building", mesh_scale: source.mesh_scale ?? "stretch", structure };
  return parsePlaceScene({ ...scene, version: 2, objects: scene.objects.map(o => o.id === id ? next : o) });
}

export function removeMeshShell(scene: PlaceSceneDefinition, id: string) {
  const source = scene.objects.find(o => o.id === id);
  if (source?.kind !== "building" || !source.asset_id) throw new Error("Select a mesh-backed building");
  if (scene.objects.some(o => o.placement?.building_id === id)) throw new Error("Move or remove floor contents before removing the shell");
  const { structure: _structure, materials: _materials, ...object } = source;
  return parsePlaceScene({ ...scene, objects: scene.objects.map(o => o.id === id ? { ...object, kind: "mesh", mesh_role: "exterior" } : o) });
}

// Subtract the authoritative solids in horizontal bands. The resulting boxes
// cover free space, including doors and stair apertures, without sampling gaps.
export function meshShellFreeSpace(object: PlaceSceneObject) {
  parseBuildingStructure(object);
  const tolerance = 0.003, top = object.height - object.structure!.roof_height;
  const parts = buildingParts(object).map(p => ({ x1: p.x - p.w / 2 - tolerance, x2: p.x + p.w / 2 + tolerance,
    z1: p.z - p.d / 2 - tolerance, z2: p.z + p.d / 2 + tolerance, y1: p.y - p.h / 2 - tolerance, y2: p.y + p.h / 2 + tolerance }));
  const ys = [...new Set([0.02, top, ...parts.flatMap(p => [p.y1, p.y2]).filter(y => y > 0.02 && y < top)])].sort((a, b) => a - b);
  const bounds = rectPolygon({ x1: -object.width / 2, x2: object.width / 2, z1: -object.depth / 2, z2: object.depth / 2 });
  const boxes: THREE.Box3[] = [];
  for (let i = 1; i < ys.length; i++) {
    const bottom = ys[i - 1]!, upper = ys[i]!, middle = (bottom + upper) / 2;
    const occupied = parts.filter(p => p.y1 < middle && p.y2 > middle).map(rectPolygon);
    const free = occupied.length ? polygonClipping.difference(bounds, ...occupied) : [bounds];
    for (const r of polygonRects(free)) boxes.push(new THREE.Box3(new THREE.Vector3(r.x1, bottom, r.z1), new THREE.Vector3(r.x2, upper, r.z2)));
  }
  if (!boxes.length || boxes.length > 2048) throw new Error("Mesh shell free-space complexity is unsupported");
  return boxes;
}

export function inspectMeshShell(fitted: THREE.Object3D, object: PlaceSceneObject) {
  const boxes = meshShellFreeSpace(object), triangle = new THREE.Triangle(), bounds = new THREE.Box3();
  let triangles = 0, checks = 0;
  fitted.updateMatrixWorld(true);
  fitted.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    if (node instanceof THREE.InstancedMesh || node instanceof THREE.SkinnedMesh || Object.keys(node.geometry.morphAttributes).length) throw new Error("Mesh shell requires static, non-instanced geometry");
    const position = node.geometry.getAttribute("position"), index = node.geometry.getIndex();
    const count = index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      if (++triangles > 500_000) throw new Error("Mesh shell exceeds 500,000 triangles");
      for (const [offset, point] of [triangle.a, triangle.b, triangle.c].entries()) node.getVertexPosition(index ? index.getX(i + offset) : i + offset, point).applyMatrix4(node.matrixWorld);
      bounds.setFromPoints([triangle.a, triangle.b, triangle.c]);
      for (const box of boxes) {
        if (++checks > 10_000_000) throw new Error("Mesh shell inspection exceeds the complexity budget");
        if (box.intersectsBox(bounds) && box.intersectsTriangle(triangle)) {
          const point = bounds.getCenter(new THREE.Vector3());
          throw new Error(`Mesh blocks shell free space near (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}) m. Align the shell openings or edit the source mesh.`);
        }
      }
    }
  });
  if (!triangles) throw new Error("Mesh shell has no inspectable triangles");
  return { triangles, free_volumes: boxes.length, tolerance_metres: 0.003 };
}
