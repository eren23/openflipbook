import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { PlaceSceneObject } from "@openflipbook/config";
import { buildingParts } from "../../lib/building-structure";
import { fixtureMaterial } from "./material-jpeg";
import { buildStructuredBuilding } from "../../components/sketch/structured-building";

// A deliberately authored compatibility fixture, not generated architecture.
export function fixtureShellModel(object: PlaceSceneObject, solid = false) {
  const group = new THREE.Group(), material = new THREE.MeshBasicMaterial();
  const add = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); group.add(mesh);
  };
  if (solid) add(0, object.height / 2, 0, object.width, object.height, object.depth);
  else {
    for (const p of buildingParts(object)) if (p.y >= 0) add(p.x, p.y, p.z, p.w, p.h, p.d);
    const source = new THREE.Group(), { asset_id: _asset, ...authored } = object; buildStructuredBuilding(authored, source, [], false);
    for (const node of source.children) if (node instanceof THREE.Mesh && node.userData.surface === "roof") {
      const geometry = node.geometry.clone(), points = geometry.getAttribute("position"), uv: number[] = [];
      for (let i = 0; i < points.count; i++) uv.push(points.getX(i) / object.width + 0.5, (points.getZ(i) + points.getY(i)) / object.depth);
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      const roof = new THREE.Mesh(geometry, material); roof.position.copy(node.position); group.add(roof);
    }
    source.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); } });
  }
  return group;
}

export function fixtureShellGlb(object: PlaceSceneObject, solid = false) {
  const model = fixtureShellModel(object, solid), geometries: THREE.BufferGeometry[] = [];
  model.updateMatrixWorld(true);
  model.traverse(node => { if (node instanceof THREE.Mesh) geometries.push((node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone()).applyMatrix4(node.matrixWorld)); });
  const geometry = mergeGeometries(geometries)!; geometry.computeBoundingBox();
  const count = geometry.getAttribute("position").count, views: { buffer: number; byteOffset: number; byteLength: number }[] = [], chunks: Buffer[] = [];
  let offset = 0;
  for (const bytes of ["position", "normal", "uv"].map(key => Buffer.from(geometry.getAttribute(key).array.buffer))) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); chunks.push(bytes); offset += bytes.length;
  }
  const image = fixtureMaterial(), padded = Buffer.alloc(Math.ceil(image.length / 4) * 4); image.copy(padded);
  views.push({ buffer: 0, byteOffset: offset, byteLength: image.length }); chunks.push(padded);
  const binary = Buffer.concat(chunks), bounds = geometry.boundingBox!;
  const source = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3", min: bounds.min.toArray(), max: bounds.max.toArray() },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" }, { bufferView: 2, componentType: 5126, count, type: "VEC2" }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } }],
    images: [{ bufferView: 3, mimeType: "image/jpeg" }], textures: [{ source: 0 }], bufferViews: views, buffers: [{ byteLength: binary.length }] };
  const json = Buffer.from(JSON.stringify(source)), length = Math.ceil(json.length / 4) * 4, bytes = Buffer.alloc(28 + length + binary.length, 32);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + length); bytes.writeUInt32LE(0x004e4942, 24 + length); binary.copy(bytes, 28 + length);
  geometry.dispose(); geometries.forEach(g => g.dispose());
  model.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); } });
  return bytes;
}
