import { expect, it, vi } from "vitest";
import * as THREE from "three";
import { bindSurfaceMaterials, materialUVs, loadSurfaceMaterials } from "./surface-materials";
import { buildPlaceScene, disposePlace } from "./place-scene-renderer";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
const binding = { asset_id: "material1", tile_metres: 2, rotation: 0, roughness: 0.4 };
it("textures ground and paths without adding solids or changing geometry, including translated chunks", () => {
  const path = newComponent("path", 10, 10), building = newComponent("building", 28, 10);
  const definition = { ...emptyPlaceScene(), ground_material: binding, objects: [{ ...path, materials: { floor: binding } }, building] };
  const built = buildPlaceScene(definition), solids = structuredClone(built.solids), texture = new THREE.Texture();
  const originals = new Map<THREE.Mesh, { vertices: number[]; material: THREE.Material | THREE.Material[] }>();
  built.scene.traverse(mesh => { if (mesh instanceof THREE.Mesh) originals.set(mesh, { vertices: [...mesh.geometry.attributes.position!.array], material: mesh.material }); });
  try {
    expect(bindSurfaceMaterials(built.scene, definition, new Map([[binding.asset_id, texture]]))).toBe(2);
    const uvs = new Map<THREE.Mesh, number[]>();
    for (const [mesh, original] of originals) {
      expect([...mesh.geometry.attributes.position!.array]).toEqual(original.vertices);
      if (mesh.userData.groundSurface || mesh.userData.objectId === path.id) {
        expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(texture);
        uvs.set(mesh, [...mesh.geometry.attributes.uv!.array]);
      } else expect(mesh.material).toBe(original.material);
    }
    built.scene.position.set(80, 0, 40); built.scene.rotation.y = Math.PI / 2;
    expect(bindSurfaceMaterials(built.scene, definition, new Map([[binding.asset_id, texture]]))).toBe(2);
    for (const [mesh, uv] of uvs) expect([...mesh.geometry.attributes.uv!.array]).toEqual(uv);
    expect(built.solids).toEqual(solids);
  } finally { disposePlace(built.scene); }
});
it("requires saved ground textures even in a place with no objects", async () => {
  const definition = { ...emptyPlaceScene(), ground_material: binding }, built = buildPlaceScene(definition);
  try {
    expect(() => bindSurfaceMaterials(built.scene, definition, new Map())).toThrow("missing");
    await expect(loadSurfaceMaterials(built.scene, definition, undefined, new AbortController().signal)).rejects.toThrow("unavailable");
  } finally { disposePlace(built.scene); }
});

it("binds only the selected surfaces, leaving vertices, other materials and collision unchanged", () => {
  const first = newComponent("building", 10, 10), second = newComponent("building", 28, 10);
  const definition = { ...emptyPlaceScene(), objects: [{ ...first, materials: { wall: binding } }, second] };
  const built = buildPlaceScene(definition), solids = structuredClone(built.solids), texture = new THREE.Texture();
  const unchanged = new Map<THREE.Mesh, { vertices: number[]; material: THREE.Material | THREE.Material[] }>();
  built.scene.traverse(mesh => { if (mesh instanceof THREE.Mesh) unchanged.set(mesh, { vertices: [...mesh.geometry.attributes.position!.array], material: mesh.material }); });
  try {
    expect(bindSurfaceMaterials(built.scene, definition, new Map([["material1", texture]]))).toBeGreaterThan(0);
    for (const [mesh, original] of unchanged) {
      expect([...mesh.geometry.attributes.position!.array]).toEqual(original.vertices);
      if (mesh.userData.objectId === first.id && mesh.userData.surface === "wall") {
        const material = mesh.material as THREE.MeshStandardMaterial;
        expect(material.map).toBe(texture); expect(material.roughness).toBe(0.4); expect(material.normalMap).toBeNull(); expect(material.bumpMap).toBeNull();
      } else expect(mesh.material).toBe(original.material);
    }
    expect(built.solids).toEqual(solids);
  } finally { disposePlace(built.scene); }
});
it("uses stable local-metre UVs with explicit tiling and rotation", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6));
  try {
    materialUVs(mesh, binding); const uv = [...mesh.geometry.attributes.uv!.array];
    const parent = new THREE.Group(); parent.position.set(100, 0, 50); parent.rotation.y = 1; parent.add(mesh);
    materialUVs(mesh, binding); expect([...mesh.geometry.attributes.uv!.array]).toEqual(uv);
    materialUVs(mesh, { ...binding, tile_metres: 4 }); expect([...mesh.geometry.attributes.uv!.array]).toEqual(uv.map(n => n / 2));
    materialUVs(mesh, { ...binding, rotation: Math.PI / 2 });
    expect(mesh.geometry.attributes.uv!.getX(0)).toBeCloseTo(-uv[1]!); expect(mesh.geometry.attributes.uv!.getY(0)).toBeCloseTo(uv[0]!);
  } finally { mesh.geometry.dispose(); }
});
it("rejects missing textures and storage instead of falling back silently", async () => {
  const definition = { ...emptyPlaceScene(), objects: [{ ...newComponent("building", 10, 10), materials: { roof: binding } }] }, built = buildPlaceScene(definition);
  try {
    expect(() => bindSurfaceMaterials(built.scene, definition, new Map())).toThrow("missing");
    await expect(loadSurfaceMaterials(built.scene, definition, undefined, new AbortController().signal)).rejects.toThrow("unavailable");
  } finally { disposePlace(built.scene); }
});
it("closes decoded image resources when loading is aborted", async () => {
  const controller = new AbortController(), close = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => { controller.abort(); return { close }; }));
  const definition = { ...emptyPlaceScene(), objects: [{ ...newComponent("building", 10, 10), materials: { wall: binding } }] };
  try { expect(await loadSurfaceMaterials(new THREE.Scene(), definition, "/materials", controller.signal)).toBe(0); expect(close).toHaveBeenCalledOnce(); }
  finally { vi.unstubAllGlobals(); }
});
