import * as THREE from "three";

interface FixtureSource {
  asset: { version: string }; scene: number; scenes: { nodes: number[] }[];
  nodes: { mesh?: number; scale?: number[]; translation?: number[]; rotation?: number[]; children?: number[]; extensions?: Record<string, unknown> }[];
  meshes: { primitives: { attributes: { POSITION: number; NORMAL: number; TEXCOORD_0?: number }; material: number; indices?: number }[] }[];
  materials: { pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number; baseColorTexture?: { index: number } } }[];
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  accessors: { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }[];
  images?: { bufferView: number; mimeType: string }[]; textures?: { source: number }[];
}

export function fixtureTexturedGlb(texture: Buffer, edit?: (source: FixtureSource) => void) {
  const base = fixtureGlb(), jsonLength = base.readUInt32LE(12), source = JSON.parse(base.subarray(20, 20 + jsonLength).toString("utf8")) as FixtureSource;
  const binary = base.subarray(28 + jsonLength), geometry = new THREE.BoxGeometry(2, 4, 3).toNonIndexed();
  const uvs = Buffer.from(geometry.attributes.uv!.array.buffer), pixels = Buffer.alloc(Math.ceil(texture.length / 4) * 4); texture.copy(pixels);
  source.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: uvs.length }, { buffer: 0, byteOffset: binary.length + uvs.length, byteLength: texture.length });
  source.accessors.push({ bufferView: 2, componentType: 5126, count: 36, type: "VEC2" });
  source.meshes[0]!.primitives[0]!.attributes.TEXCOORD_0 = 2;
  source.materials[0]!.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  source.materials[0]!.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  source.images = [{ bufferView: 3, mimeType: "image/png" }]; source.textures = [{ source: 0 }];
  const data = Buffer.concat([binary, uvs, pixels]); source.buffers[0]!.byteLength = data.length; edit?.(source);
  const json = Buffer.from(JSON.stringify(source)), length = Math.ceil(json.length / 4) * 4, out = Buffer.alloc(28 + length + data.length, 32);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  out.writeUInt32LE(data.length, 20 + length); out.writeUInt32LE(0x004e4942, 24 + length); data.copy(out, 28 + length);
  geometry.dispose(); return out;
}

// Labelled geometry for loader/storage tests; never evidence of AI quality.
export function fixtureGlb(edit?: (source: FixtureSource) => void) {
  const geometry = new THREE.BoxGeometry(2, 4, 3).toNonIndexed();
  const positions = Buffer.from(geometry.attributes.position!.array.buffer), normals = Buffer.from(geometry.attributes.normal!.array.buffer);
  const binary = Buffer.concat([positions, normals]);
  const source = {asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[0.05,0.65,0.45,1],metallicFactor:0,roughnessFactor:0.6}}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length},{buffer:0,byteOffset:positions.length,byteLength:normals.length}],accessors:[{bufferView:0,componentType:5126,count:36,type:"VEC3",min:[-1,-2,-1.5],max:[1,2,1.5]},{bufferView:1,componentType:5126,count:36,type:"VEC3"}]};
  edit?.(source);
  const json = Buffer.from(JSON.stringify(source)), length = Math.ceil(json.length/4)*4, out = Buffer.alloc(28+length+binary.length,32);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);
  out.writeUInt32LE(binary.length,20+length);out.writeUInt32LE(0x004e4942,24+length);binary.copy(out,28+length);
  geometry.dispose(); return out;
}
