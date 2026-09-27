export const MAX_MESH_BYTES = 80 * 1024 * 1024;
export const MESH_MODEL = "fal-ai/hunyuan3d-v3/text-to-3d";
export const MESH_IMAGE_MODEL = "fal-ai/hunyuan3d-v3/image-to-3d";
export const IMPORTED_MESH_MODEL = "imported/glb";
export interface MeshImportProvenance { kind: "imported_mesh"; filename: string; validator_version: string; warnings: string[] }
export interface MeshSource {
  id: string; label: string; sha256: string; width: number; height: number;
  origin: { kind: "imported_reference" | "saved_world_image"; node_id?: string; image_model?: string };
}
export interface SavedMesh { id: string; prompt: string; model: string; sha256: string; source_id?: string; imported?: MeshImportProvenance }
export interface MeshPlacement { prompt: string; asset_id?: string }
export type MeshJobState = "scheduled" | "submitting" | "queued" | "running" | "storing" | "storage_failed" | "ready" | "failed" | "submission_unknown" | "cancelled";
export interface MeshJob {
  id: string;
  prompt: string;
  model: string;
  status: MeshJobState;
  reservation: number;
  asset_id?: string;
  error?: string;
  source_id?: string;
}

// Only self-contained GLBs may enter the viewer: no secondary URL fetches.
export function validateMeshGlb(bytes: Uint8Array) {
  if (bytes.byteLength < 28 || bytes.byteLength > MAX_MESH_BYTES) throw new Error("Invalid GLB size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new Error("Expected a complete GLB 2.0 file");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > 8 * 1024 * 1024 || 20 + length > bytes.byteLength) throw new Error("Invalid GLB JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  if (json.asset?.version !== "2.0" || !Array.isArray(json.meshes) || !json.meshes.length || json.meshes.length > 1000) throw new Error("GLB has no supported meshes");
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) if (item.uri !== undefined) throw new Error("GLB must embed all buffers and textures");
  if ((json.extensionsRequired ?? []).length) throw new Error("Compressed or extension-dependent GLBs are not supported yet");
  if (json.animations?.length || json.skins?.length) throw new Error("Animated meshes are not supported yet");
  let count = 0;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives ?? []) {
    const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION];
    if (!accessor || !Number.isSafeInteger(accessor.count) || accessor.count <= 0) throw new Error("Invalid mesh accessor");
    count += accessor.count;
  }
  if (count <= 0 || count > 1_500_000) throw new Error("Mesh exceeds the viewer geometry budget");
  return { mesh_count: json.meshes.length, index_count: count };
}

export function meshDownloadUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Missing generated GLB");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"))) throw new Error("Unsupported mesh download host");
  return url.toString();
}
