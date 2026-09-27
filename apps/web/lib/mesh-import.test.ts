// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
const f = vi.hoisted(() => ({ assets: new Map<string, Record<string, unknown>>(), blobs: new Map<string, Buffer>(), owner: true, failWrite: false }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => {
  if (!f.owner) throw Object.assign(new Error("Not owner"), { status: 403 });
  return { collection: () => ({ findOne: async ({ _id }: { _id: string }) => f.assets.get(_id) ?? null,
    updateOne: async ({ _id }: { _id: string }, { $setOnInsert }: { $setOnInsert: Record<string, unknown> }) => { if (f.failWrite) throw new Error("DB failed"); if (!f.assets.has(_id)) f.assets.set(_id, $setOnInsert); } }) };
} }));
vi.mock("./r2", () => ({ uploadJpeg: vi.fn(async (key: string, bytes: Buffer) => { f.blobs.set(key, bytes); }), getStoredBytes: vi.fn(async (key: string) => f.blobs.has(key) ? { bytes: f.blobs.get(key)! } : null) }));
import { inspectMeshImport, importMesh } from "./mesh-import";
import { fixtureGlb, fixtureTexturedGlb } from "../e2e/fixtures/mesh-glb";
import { uploadJpeg } from "./r2";
beforeEach(() => { f.assets.clear(); f.blobs.clear(); f.owner = true; f.failWrite = false; vi.clearAllMocks(); });
it("validates real embedded geometry and textures without network or byte changes", async () => {
  const texture = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3167bb" } }).png().toBuffer();
  const bytes = fixtureTexturedGlb(texture), original = Buffer.from(bytes);
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  try { expect(await inspectMeshImport(bytes)).toMatchObject({ size: { width: 2, height: 4, depth: 3 }, validator_version: "2.0.0-dev.3.10", warnings: [] }); expect(bytes).toEqual(original); expect(fetcher).not.toHaveBeenCalled(); }
  finally { fetcher.mockRestore(); }
});
it.each(["external", "cycle", "offset", "bounds", "accessor allocation", "instances", "indexed instances", "GPU instances", "draw primitives", "scenes", "flattened"])("rejects invalid %s before persistence", async change => {
  const bytes = fixtureGlb(json => {
    if (change === "external") json.buffers[0]!.uri = "https://example.test/secret";
    if (change === "cycle") json.nodes[0]!.children = [0];
    if (change === "offset") json.bufferViews[0]!.byteOffset = 999999;
    if (change === "bounds") json.accessors[0]!.max = [100, 100, 100];
    if (change === "accessor allocation") json.accessors[1]!.count = 1_000_000_000;
    if (change === "instances") { json.accessors[0]!.count = 1_000_000; json.nodes.push({ mesh: 0 }); json.scenes[0]!.nodes.push(1); }
    if (change === "indexed instances") { json.accessors.push({ bufferView: 0, componentType: 5123, type: "SCALAR", count: 900_000 }); json.meshes[0]!.primitives[0]!.indices = 2; json.nodes.push({ mesh: 0 }); json.scenes[0]!.nodes.push(1); }
    if (change === "GPU instances") json.nodes[0]!.extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } } };
    if (change === "draw primitives") { json.meshes[0]!.primitives = Array.from({ length: 2049 }, () => ({ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 })); }
    if (change === "scenes") json.scenes = Array.from({ length: 17 }, () => ({ nodes: [0] }));
    if (change === "flattened") json.nodes[0]!.scale = [0, 1, 1];
  });
  const messages: Record<string, string> = { "indexed instances": "GLB instances exceed the geometry budget", "GPU instances": "GPU-instanced GLBs are not supported", "draw primitives": "2048 draw primitives", scenes: "scene/material budget" };
  await expect(importMesh("world", bytes, "test.glb")).rejects.toMatchObject({ status: 422, ...(messages[change] ? { message: expect.stringContaining(messages[change]!) } : {}) }); expect(uploadJpeg).not.toHaveBeenCalled(); expect(f.assets.size).toBe(0);
});
it("rejects corrupt embedded images and over-budget textures", async () => {
  await expect(inspectMeshImport(fixtureTexturedGlb(Buffer.from("invalid image")))).rejects.toThrow();
  const huge = await sharp({ create: { width: 4097, height: 16, channels: 3, background: "#123456" } }).png().toBuffer();
  await expect(inspectMeshImport(fixtureTexturedGlb(huge))).rejects.toThrow("4096px");
});
// Encodes 4K textures: under 1 s alone, past the 5 s default on a loaded CI runner.
it("round-trips a bounded 4K PBR texture set but still rejects combined texture overflow", async () => {
  const texture = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: "#3167bb" } }).png().toBuffer();
  const fixture = (count: number) => fixtureTexturedGlb(texture, source => {
    source.images = Array.from({ length: count }, () => ({ bufferView: 3, mimeType: "image/png" }));
    source.textures = source.images.map((_image, index) => ({ source: index }));
  });
  expect(await inspectMeshImport(fixture(4))).toMatchObject({ size: { width: 2, height: 4, depth: 3 } });
  await expect(inspectMeshImport(fixture(5))).rejects.toThrow("64 megapixels");
}, 30_000);
it("stores immutable import provenance without fabricating a model job or provider request", async () => {
  const bytes = fixtureGlb(); const result = await importMesh("world", bytes, "Monument.glb");
  const asset = f.assets.get(`world:${result.asset.id}`)!;
  expect(asset).toMatchObject({ model: "imported/glb", imported: { filename: "Monument.glb", kind: "imported_mesh" }, geometry: { size: { width: 2, height: 4, depth: 3 } } });
  expect(asset).not.toHaveProperty("request_id"); expect(f.blobs.get(asset.key as string)).toEqual(bytes);
  expect(await importMesh("world", bytes, "Monument.glb")).toEqual(result); expect(f.assets.size).toBe(1); expect(uploadJpeg).toHaveBeenCalledTimes(1);
});
it("recovers a lost publication and missing immutable blob by retrying the same file", async () => {
  const bytes = fixtureGlb(); f.failWrite = true;
  await expect(importMesh("world", bytes, "Monument.glb")).rejects.toThrow("DB failed"); expect(f.assets.size).toBe(0);
  f.failWrite = false; const result = await importMesh("world", bytes, "Monument.glb"); f.blobs.clear();
  expect(await importMesh("world", bytes, "Monument.glb")).toEqual(result); expect(f.assets.size).toBe(1); expect(f.blobs.size).toBe(1);
});
it("deduplicates concurrent imports and retains the first published provenance on renamed reimport", async () => {
  const bytes = fixtureGlb(), [first, concurrent] = await Promise.all([importMesh("world", bytes, "First.glb"), importMesh("world", bytes, "Renamed.glb")]);
  expect(first).toEqual(concurrent); expect(f.assets.size).toBe(1); expect(f.blobs.size).toBe(1);
  expect(await importMesh("world", bytes, "Third.glb")).toEqual(first);
});
it("checks ownership before parsing untrusted input", async () => {
  f.owner = false; await expect(importMesh("world", Buffer.from("bad"), "bad.glb")).rejects.toMatchObject({ status: 403 }); expect(uploadJpeg).not.toHaveBeenCalled();
});
it("strips path and control characters from display metadata without using the filename as a storage key", async () => {
  const result = await importMesh("world", fixtureGlb(), "../private\\Monu\u0000ment\u001f\u007f.glb");
  expect(result.asset.prompt).toBe("Monument.glb"); expect(result.asset.imported?.filename).toBe("Monument.glb");
  const key = f.assets.get(`world:${result.asset.id}`)!.key as string;
  expect(key).not.toContain("private"); expect(key).not.toContain("Monument");
});
