import {describe, it, expect} from "vitest";
import {meshDownloadUrl, validateMeshGlb} from "./mesh-asset";
import {gardenScene, newComponent, parsePlaceScene, sceneChanges} from "./place-scene";
function glb(patch = {}) {
  const json = Buffer.from(JSON.stringify({asset: {version: "2.0"}, meshes: [{primitives: [{attributes: {POSITION: 0}}]}], accessors: [{count: 3}], ...patch}));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + length, 32);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20); return bytes;
}
describe("generated asset boundary", () => {
  it("accepts self-contained GLB metadata", () => {expect(validateMeshGlb(glb()).mesh_count).toBe(1);});
  it.each([{buffers: [{uri: "https://evil.test/a.bin"}]}, {images: [{uri: "http://127.0.0.1/private"}]}, {images: [{uri: "data:image/png;base64,abc"}]}, {extensionsRequired: ["KHR_draco_mesh_compression"]}, {animations: [{}]}, {skins: [{}]}])("rejects external or unsupported assets %j", patch => {expect(() => validateMeshGlb(glb(patch))).toThrow();});
  it("rejects invalid/truncated headers and excessive geometry", () => {
    expect(() => validateMeshGlb(new Uint8Array(30))).toThrow();
    expect(() => validateMeshGlb(glb().subarray(0, 28))).toThrow();
    expect(() => validateMeshGlb(glb({accessors: [{count: 2_000_000}]}))).toThrow();
  });
  it("only downloads provider-hosted HTTPS assets", () => {
    expect(meshDownloadUrl("https://v3b.fal.media/files/model.glb")).toContain("model.glb");
    for (const url of ["http://fal.media/a", "https://fal.media.evil.test/a", "https://127.0.0.1/a", "https://x:secret@fal.media/a", "https://fal.media:9000/a"]) expect(() => meshDownloadUrl(url)).toThrow();
  });
  it("preserves asset identity through scene validation and records replacement", () => {
    const definition = {...gardenScene(), objects: [{...newComponent("mesh", 5, 5), asset_id: "mesh_example"}]};
    const saved = parsePlaceScene(definition); expect(saved.objects[0]!.asset_id).toBe("mesh_example");
    const replacement = structuredClone(saved); replacement.objects[0]!.asset_id = "mesh_other";
    expect(sceneChanges(saved, replacement)).toContain("Update Mesh");
    const missing = {...definition, objects: [newComponent("mesh", 5, 5)]}; expect(() => parsePlaceScene(missing)).toThrow("asset binding");
  });
  it("refuses to bind a generated asset to a procedural object", () => {
    const definition = gardenScene(); definition.objects[0]!.asset_id = "mesh_example";
    expect(() => parsePlaceScene(definition)).toThrow("asset binding");
  });
});
