// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { measureMeshGlb } from "./mesh-geometry";
import { fixtureGlb } from "../e2e/fixtures/mesh-glb";

afterEach(() => vi.unstubAllGlobals());
it("measures real embedded geometry in Node without a browser or network", async () => {
  const fetch = vi.fn(() => { throw new Error("Unexpected network"); }); vi.stubGlobal("fetch", fetch);
  expect(await measureMeshGlb(fixtureGlb())).toEqual({ width: 2, height: 4, depth: 3 });
  expect(fetch).not.toHaveBeenCalled();
});
it("uses actual vertices and composed node transforms, not declared accessor bounds", async () => {
  const bytes = fixtureGlb(json => {
    json.accessors[0]!.min = [-99, -99, -99]; json.accessors[0]!.max = [99, 99, 99];
    json.nodes = [{ translation: [8, 9, -4], rotation: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)], children: [1] }, { mesh: 0, scale: [2, 1, 1] }];
  });
  const size = await measureMeshGlb(bytes);
  expect(size.width).toBeCloseTo(3); expect(size.height).toBeCloseTo(4); expect(size.depth).toBeCloseTo(4);
});
it("skips embedded texture decoding without skipping geometry", async () => {
  const bytes = fixtureGlb(json => {
    json.images = [{ bufferView: 0, mimeType: "image/png" }]; json.textures = [{ source: 0 }];
    json.materials[0]!.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  });
  expect(await measureMeshGlb(bytes)).toEqual({ width: 2, height: 4, depth: 3 });
});
it("rejects external buffers, empty default scenes, and flattened geometry", async () => {
  await expect(measureMeshGlb(fixtureGlb(json => { json.buffers[0]!.uri = "https://example.org/mesh.bin"; }))).rejects.toThrow("embed");
  await expect(measureMeshGlb(fixtureGlb(json => { json.scenes[0]!.nodes = []; }))).rejects.toThrow("invalid bounds");
  await expect(measureMeshGlb(fixtureGlb(json => { json.nodes[0]!.scale = [0, 1, 1]; }))).rejects.toThrow("invalid bounds");
});
