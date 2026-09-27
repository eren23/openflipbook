import { createHash } from "node:crypto";
import sharp from "sharp";
import { validateBytes, version } from "gltf-validator";
import { requireCreator, CreatorError } from "./creator";
import { getStoredBytes, uploadJpeg } from "./r2";
import { validateMeshGlb, IMPORTED_MESH_MODEL, type MeshImportProvenance } from "./mesh-asset";
import { measureMeshGlb } from "./mesh-geometry";
import type { MeshAssetDoc } from "./mesh-execution";

export async function inspectMeshImport(bytes: Buffer) {
  validateMeshGlb(bytes);
  const jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  if (bytes.length < 28 + jsonLength || bytes.readUInt32LE(24 + jsonLength) !== 0x004e4942 || 28 + jsonLength + bytes.readUInt32LE(20 + jsonLength) !== bytes.length) throw new Error("Expected one embedded GLB binary chunk");
  if (!Array.isArray(json.nodes) || json.nodes.length > 512 || !Array.isArray(json.accessors) || json.accessors.length > 4096) throw new Error("GLB exceeds the scene complexity budget");
  if (!Array.isArray(json.scenes) || !json.scenes.length || json.scenes.length > 16 || (json.materials?.length ?? 0) > 2048) throw new Error("GLB exceeds the scene/material budget");
  // Bound declared allocations before either validator or loader touches sparse
  // data. File size alone does not constrain accessor allocation or instancing.
  let allocated = 0;
  for (const accessor of json.accessors) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count <= 0 || accessor.count > 1_500_000) throw new Error("GLB accessor exceeds the geometry budget");
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>)[accessor.type];
    if (!components) throw new Error("Unsupported GLB accessor");
    allocated += accessor.count * components * 4;
  }
  if (allocated > 128 * 1024 * 1024) throw new Error("GLB decoded geometry exceeds 128 MiB");
  let vertices = 0, indices = 0, primitives = 0;
  for (const node of json.nodes) if (node.mesh !== undefined) {
    if (node.extensions?.EXT_mesh_gpu_instancing) throw new Error("GPU-instanced GLBs are not supported. Export regular mesh nodes instead.");
    const mesh = json.meshes[node.mesh]; if (!mesh) throw new Error("Invalid GLB mesh reference");
    for (const primitive of mesh.primitives ?? []) {
      primitives++;
      if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error("Only triangle meshes are supported");
      vertices += json.accessors[primitive.attributes?.POSITION]?.count ?? 0;
      indices += json.accessors[primitive.indices ?? primitive.attributes?.POSITION]?.count ?? 0;
    }
  }
  if (vertices > 1_500_000 || indices > 1_500_000) throw new Error("GLB instances exceed the geometry budget");
  if (primitives > 2048) throw new Error("GLB exceeds 2048 draw primitives");
  const report = await validateBytes(new Uint8Array(bytes), { format: "glb", maxIssues: 50, writeTimestamp: false });
  if (report.issues.numErrors || report.issues.truncated) {
    const issue = report.issues.messages.find(m => m.severity === 0);
    throw new Error(`GLB validation failed${issue ? `: ${issue.code}` : ": report limit reached"}`);
  }
  const images = json.images ?? []; if (images.length > 32) throw new Error("GLB exceeds 32 embedded textures");
  let pixels = 0;
  for (const image of images) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) throw new Error("Unsupported embedded texture format");
    const view = json.bufferViews[image.bufferView], start = 28 + jsonLength + (view.byteOffset ?? 0);
    const texture = sharp(bytes.subarray(start, start + view.byteLength), { limitInputPixels: 16_777_216, failOn: "warning" });
    const info = await texture.metadata();
    if (!info.width || !info.height || info.width > 4096 || info.height > 4096 || (info.pages ?? 1) !== 1) throw new Error("Embedded textures must be single-frame and at most 4096px");
    pixels += info.width * info.height;
    // A standard PBR asset can carry four separate 4K maps. The previous
    // two-map cap rejected our own saved three-map generated assets on restore.
    if (pixels > 67_108_864) throw new Error("GLB textures exceed 64 megapixels combined");
    await texture.stats();
  }
  return { size: await measureMeshGlb(bytes), validator_version: version(), warnings: report.issues.messages.filter(m => m.severity === 1).map(m => m.code) };
}

export async function importMesh(sid: string, bytes: Buffer, filename: string) {
  const db = await requireCreator(sid);
  const printable = Array.from(filename).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("");
  const label = printable.split(/[\\/]/).at(-1)?.trim().slice(0, 160);
  if (!label || !label.toLowerCase().endsWith(".glb")) throw new CreatorError("Choose a GLB file", 400);
  let inspection;
  try { inspection = await inspectMeshImport(bytes); }
  catch (e) { throw new CreatorError((e instanceof Error ? e.message : "Invalid GLB").slice(0, 300), 422); }
  const sha256 = createHash("sha256").update(bytes).digest("hex"), id = `import_${sha256}`;
  const assets = db.collection<MeshAssetDoc>("mesh_assets"), old = await assets.findOne({ _id: `${sid}:${id}`, session_id: sid });
  if (old) {
    const stored = await getStoredBytes(old.key);
    if (!stored || createHash("sha256").update(stored.bytes).digest("hex") !== sha256) await uploadJpeg(old.key, bytes, "model/gltf-binary");
    return { asset: { id: old.id, prompt: old.prompt, model: old.model, sha256: old.sha256, imported: old.imported } };
  }
  const key = `${sid}/meshes/${id}/${sha256}.glb`;
  await uploadJpeg(key, bytes, "model/gltf-binary");
  const imported: MeshImportProvenance = { kind: "imported_mesh", filename: label, validator_version: inspection.validator_version, warnings: inspection.warnings };
  const asset: MeshAssetDoc = { _id: `${sid}:${id}`, id, session_id: sid, key, sha256, bytes: bytes.length,
    model: IMPORTED_MESH_MODEL, prompt: label, imported, geometry: { sha256, size: inspection.size }, created_at: new Date() };
  await assets.updateOne({ _id: asset._id }, { $setOnInsert: asset }, { upsert: true });
  const saved = await assets.findOne({ _id: asset._id, session_id: sid });
  if (!saved) throw new CreatorError("Imported mesh publication unavailable. Retry the same file.", 503);
  return { asset: { id, prompt: saved.prompt, model: saved.model, sha256, imported: saved.imported } };
}
