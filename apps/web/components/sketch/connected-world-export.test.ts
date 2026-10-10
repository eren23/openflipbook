import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { PlaceConnection, PlaceNetwork, PlaceSceneSnapshot } from "@openflipbook/config";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import { buildConnectedPlaces } from "./connected-place-renderer";
import { disposePlace, THREE } from "./place-scene-renderer";
import { exportConnectedWorld, portableRoofMaterials } from "./connected-world-export";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(mesh = false): PlaceNetwork {
  const scene = (id: string, width: number, depth: number, positions: [number, number][]): PlaceSceneSnapshot => ({
    id: `scene_${id}`, place_id: id, session_id: "world", revision: id === "root" ? 5 : 2, source_node_id: null, source_image_key: null,
    updated_at: new Date(0).toISOString(), definition: { ...emptyPlaceScene(), width, depth, label: id, entrance: { x: 5, z: depth - 3, yaw: 0 },
      objects: positions.map(([x, z]) => newComponent("building", x, z)) } });
  const root = scene("root", 40, 40, [[20, 20], [7, 10], [30, 31]]), west = scene("west", 16, 40, [[8, 10], [8, 29]]),
    north = scene("north", 40, 40, [[20, 20]]), annex = scene("annex", 24, 32, [[9, 7], [16, 25]]);
  const workshop = root.definition.objects[0]!; workshop.height = 7.8; workshop.structure!.floors.push({ id: "upper", label: "Upper floor" });
  if (mesh) root.definition.objects.push({ ...newComponent("mesh", 0, 0), id: "chair", entity_id: "chair_entity", label: "Chair",
    width: 1, depth: 1, height: 2, asset_id: "saved_chair", placement: { building_id: workshop.id, floor_id: "upper" } });
  const connect = (id: string, a: PlaceConnection["a"], b: PlaceConnection["b"]): PlaceConnection => ({ id, version: 1, kind: "boundary", a, b, width: 3, created_at: new Date(0).toISOString() });
  return { chunks: [{ scene: root, x: 0, z: 0 }, { scene: annex, x: 40, z: 0 }, { scene: west, x: -16, z: 0 }, { scene: north, x: 0, z: -40 }],
    connections: [connect("annex_link", { place_id: "root", side: "east", offset: 16 }, { place_id: "annex", side: "west", offset: 16 }),
      connect("west_link", { place_id: "root", side: "west", offset: 20 }, { place_id: "west", side: "east", offset: 20 }),
      connect("north_link", { place_id: "root", side: "north", offset: 20 }, { place_id: "north", side: "south", offset: 20 })] };
}
const glbJson = (buffer: ArrayBuffer) => {
  const header = new DataView(buffer); expect(header.getUint32(0, true)).toBe(0x46546c67); expect(header.getUint32(4, true)).toBe(2);
  expect(header.getUint32(8, true)).toBe(buffer.byteLength); expect(header.getUint32(16, true)).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, header.getUint32(12, true)))) as {
    scenes: { extras: { openflipbook_world: unknown; openflipbook_connections: unknown[]; openflipbook_collision_solids: unknown[] } }[];
    nodes: { name?: string; extras?: { groundSurface?: boolean; surface?: string; openflipbook_object?: unknown } }[];
    meshes: { primitives: { mode?: number; attributes: Record<string, number> }[] }[];
  };
};

it("exports the actual four-place eight-building network as one loadable binary GLB with exact normalized provenance and collision", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const network = fixture(), before = structuredClone(network), canonical = buildConnectedPlaces(network, "root");
  try {
    const result = await exportConnectedWorld({ network, rootPlaceId: "root" }), bytes = await result.blob.arrayBuffer(), gltf = glbJson(bytes);
    expect(result.blob.type).toBe("model/gltf-binary"); expect(result.sha256).toBe(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
    expect(result.manifest).toMatchObject({ units: "authored_metres", coordinate_system: "right_handed_y_up", source_origin: { x: -16, z: -40 },
      bounds: { width: 80, depth: 80, occupied_area: 4608 } });
    expect(result.manifest.places.find(place => place.place_id === "root")).toMatchObject({ revision: 5, normalized_origin: { x: 16, z: 40 } });
    for (const place of result.manifest.places) expect(place.definition_sha256).toBe(createHash("sha256").update(JSON.stringify(network.chunks.find(chunk => chunk.scene.place_id === place.place_id)!.scene.definition)).digest("hex"));
    expect(gltf.scenes[0]!.extras.openflipbook_world).toEqual(result.manifest);
    expect(gltf.scenes[0]!.extras.openflipbook_connections).toEqual(network.connections);
    expect(gltf.scenes[0]!.extras.openflipbook_collision_solids).toEqual(JSON.parse(JSON.stringify(canonical.solids)));
    expect(gltf.nodes.filter(node => node.extras?.groundSurface)).toHaveLength(4);
    expect(gltf.nodes.filter(node => node.extras?.openflipbook_object)).toHaveLength(8);
    expect(gltf.nodes.filter(node => node.extras?.surface === "stair").length).toBeGreaterThan(0);
    expect(gltf.nodes.filter(node => node.extras?.surface === "roof")).toHaveLength(8);
    expect(gltf.meshes.every(mesh => mesh.primitives.every(primitive => primitive.attributes.POSITION !== undefined
      && ((primitive.mode ?? 4) !== 4 || primitive.attributes.NORMAL !== undefined)))).toBe(true);
    const loaded = await new GLTFLoader().parseAsync(bytes, "");
    try {
      loaded.scene.updateMatrixWorld(true); canonical.scene.updateMatrixWorld(true);
      const actual = new THREE.Box3().setFromObject(loaded.scene), expected = new THREE.Box3().setFromObject(canonical.scene);
      expect(actual.min.toArray()).toEqual(expected.min.toArray()); expect(actual.max.toArray()).toEqual(expected.max.toArray());
      const building = network.chunks[0]!.scene.definition.objects[0]!, origin = new THREE.Vector3(building.x + 16, 1.6, building.z + 40 + building.depth / 2 + 1);
      // A real doorway stays open; a footprint box would hit within one metre.
      const hits = new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1), 0, 3).intersectObject(loaded.scene, true).filter(hit => hit.object instanceof THREE.Mesh);
      expect(hits).toHaveLength(0);
    } finally { const cleanup = new THREE.Scene(); cleanup.add(loaded.scene); disposePlace(cleanup); }
    expect(network).toEqual(before);
  } finally { disposePlace(canonical.scene); }
});

it("loads immutable generated GLB vertices and retains the actual upper-floor transform and entity extras", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const source = new THREE.Scene(), mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial()); mesh.position.set(8, 9, -4); source.add(mesh);
  try {
    const original = await new GLTFExporter().parseAsync(source, { binary: true }) as ArrayBuffer;
    const fetch = vi.fn(async () => new Response(original)); vi.stubGlobal("fetch", fetch);
    const result = await exportConnectedWorld({ network: fixture(true), rootPlaceId: "root", assetBaseUrl: "/owned/meshes" });
    expect(result.manifest.generated_assets).toEqual([{ place_id: "root", object_id: "chair", asset_id: "saved_chair", meshes: 1, vertices: 24 }]);
    expect(fetch).toHaveBeenCalledWith("/owned/meshes/saved_chair", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const loaded = await new GLTFLoader().parseAsync(await result.blob.arrayBuffer(), "");
    try {
      loaded.scene.updateMatrixWorld(true); let chair: THREE.Object3D | undefined;
      loaded.scene.traverse(object => { if (object.userData.openflipbook_object?.object_id === "chair") chair = object; });
      expect(chair).toBeDefined();
      expect(chair!.userData.openflipbook_object).toMatchObject({ asset_id: "saved_chair", entity_id: "chair_entity", placement: { floor_id: "upper" } });
      const bounds = new THREE.Box3().setFromObject(chair!);
      expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([1, 2, 1]); expect(bounds.min.y).toBeCloseTo(3.2);
      expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(36); expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(60);
    } finally { const cleanup = new THREE.Scene(); cleanup.add(loaded.scene); disposePlace(cleanup); }
  } finally { disposePlace(source); }
});

it("refuses missing assets, foreign sources, broken portals and cancellation without exporting substitutes", async () => {
  vi.stubGlobal("crypto", webcrypto); const fetch = vi.fn(async () => new Response("missing", { status: 404 })); vi.stubGlobal("fetch", fetch);
  await expect(exportConnectedWorld({ network: fixture(true), rootPlaceId: "root" })).rejects.toThrow("storage");
  await expect(exportConnectedWorld({ network: fixture(true), rootPlaceId: "root", assetBaseUrl: "/owned/meshes" })).rejects.toThrow("could not be loaded");
  const foreign = fixture(); foreign.chunks[1]!.scene.session_id = "other-world";
  await expect(exportConnectedWorld({ network: foreign, rootPlaceId: "root" })).rejects.toThrow("inconsistent");
  const moved = fixture(); moved.chunks[1]!.x++;
  await expect(exportConnectedWorld({ network: moved, rootPlaceId: "root" })).rejects.toThrow("align");
  const controller = new AbortController(); controller.abort();
  await expect(exportConnectedWorld({ network: fixture(), rootPlaceId: "root", signal: controller.signal })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("bakes the existing untextured roof tint into portable linear color without changing its triangles", () => {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardMaterial({ color: "#ff0000" }); material.userData.roofTint = { value: 1 };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material), vertices = [...mesh.geometry.getAttribute("position").array]; scene.add(mesh);
  try {
    portableRoofMaterials(scene); expect(material.color.toArray()).toEqual([.102048, .18071, .17008]);
    expect(material.userData.openflipbook_roof_tint_baked).toBe(true); expect([...mesh.geometry.getAttribute("position").array]).toEqual(vertices);
  } finally { disposePlace(scene); }
});

it("bakes textured tint, preserves metre UVs and retains the texture shared with an unchanged wall", () => {
  const scene = new THREE.Scene(), image = { width: 1, height: 1 }, texture = new THREE.Texture(image as TexImageSource);
  texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  const roof = new THREE.MeshStandardMaterial({ map: texture }), wall = new THREE.MeshStandardMaterial({ map: texture }); roof.userData.roofTint = { value: 1 };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), roof), other = new THREE.Mesh(new THREE.BoxGeometry(), wall);
  scene.add(mesh, other); const uv = mesh.geometry.getAttribute("uv"), pixels = { data: new Uint8ClampedArray([255, 0, 0, 128]) };
  const context = { drawImage: vi.fn(), getImageData: () => pixels, putImageData: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  vi.spyOn(document, "createElement").mockReturnValue(canvas); const dispose = vi.spyOn(texture, "dispose");
  try {
    portableRoofMaterials(scene);
    expect([...pixels.data]).toEqual([90, 118, 115, 128]); expect(roof.map).not.toBe(texture); expect(wall.map).toBe(texture);
    expect(roof.map!.image).toBe(canvas); expect(roof.map!.flipY).toBe(false); expect(roof.map!.wrapS).toBe(THREE.RepeatWrapping);
    expect(mesh.geometry.getAttribute("uv")).toBe(uv); expect(dispose).not.toHaveBeenCalled(); expect(context.putImageData).toHaveBeenCalledOnce();
  } finally { disposePlace(scene); }
});
