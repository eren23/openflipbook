import type { PlaceNetwork } from "@openflipbook/config";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { parsePlaceScene, sceneGeos } from "@/lib/place-scene";
import { validateConnections } from "@/lib/place-connections";
import { buildConnectedPlaces } from "./connected-place-renderer";
import { loadGeneratedMeshes } from "./generated-mesh";
import { loadSurfaceMaterials } from "./surface-materials";
import { applyRoofMaterials, applyStreetMaterials } from "./street-materials";
import { disposePlace, THREE } from "./place-scene-renderer";

export interface ConnectedWorldExportInput {
  network: PlaceNetwork;
  rootPlaceId: string;
  assetBaseUrl?: string | undefined;
  materialBaseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}
export interface ConnectedWorldExportManifest {
  format: "openflipbook-connected-glb";
  version: 1;
  units: "authored_metres";
  coordinate_system: "right_handed_y_up";
  session_id: string;
  root_place_id: string;
  source_origin: { x: number; z: number };
  bounds: { width: number; depth: number; occupied_area: number };
  places: { place_id: string; scene_id: string; revision: number; definition_sha256: string;
    label: string; source_origin: { x: number; z: number }; normalized_origin: { x: number; z: number }; object_ids: string[] }[];
  geometry: { meshes: number; vertices: number; triangles: number; collision_solids: number };
  generated_assets: { place_id: string; object_id: string; asset_id: string; meshes: number; vertices: number }[];
  lighting: { sky: string; ground: string; intensity: number } | null;
}
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

// glTF stores PBR materials rather than Three shader hooks. Bake this existing
// roof shader into portable base color; preserve its UVs and all geometry.
export function portableRoofMaterials(scene: THREE.Scene) {
  const processed = new Set<THREE.Material>(), replaced = new Set<THREE.Texture>();
  const color = new THREE.Color(), output = new THREE.Color();
  scene.traverse(mesh => {
    if (!(mesh instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial) || processed.has(material)) continue;
      processed.add(material);
      if (material.userData.roofTint?.value !== 1) continue;
      if (material.map) {
        const previous = material.map, image = previous.image as CanvasImageSource & { width: number; height: number };
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d"); if (!context) throw new Error("Roof export needs image decoding");
        context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let index = 0; index < pixels.data.length; index += 4) {
          color.setRGB(pixels.data[index]! / 255, pixels.data[index + 1]! / 255, pixels.data[index + 2]! / 255, THREE.SRGBColorSpace).multiply(material.color);
          const luma = color.r * .2126 + color.g * .7152 + color.b * .0722;
          color.setRGB(luma * .48, luma * .85, luma * .8).getRGB(output, THREE.SRGBColorSpace);
          pixels.data[index] = Math.round(output.r * 255); pixels.data[index + 1] = Math.round(output.g * 255); pixels.data[index + 2] = Math.round(output.b * 255);
        }
        context.putImageData(pixels, 0, 0); const texture: THREE.Texture = new THREE.Texture(canvas), source = texture.source;
        texture.copy(previous); texture.source = source; texture.needsUpdate = true;
        material.map = texture; material.color.set("#ffffff"); replaced.add(previous);
      } else {
        const luma = material.color.r * .2126 + material.color.g * .7152 + material.color.b * .0722;
        material.color.setRGB(luma * .48, luma * .85, luma * .8);
      }
      material.userData.openflipbook_roof_tint_baked = true;
    }
  });
  scene.traverse(mesh => {
    if (mesh instanceof THREE.Mesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) replaced.delete(value);
    }
  });
  for (const texture of replaced) texture.dispose();
}

/** The same complete scene the walker renders, including saved meshes and UVs.
 * No reconstruction from footprint boxes or model-generated replacement geometry. */
export async function exportConnectedWorld(input: ConnectedWorldExportInput) {
  const { network, rootPlaceId, assetBaseUrl, materialBaseUrl } = input;
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (!network.chunks.length || network.chunks.length > 16 || !network.chunks.some(chunk => chunk.scene.place_id === rootPlaceId)) throw new Error("Choose a saved place in the connected world");
  const sid = network.chunks[0]!.scene.session_id, ids = new Set<string>();
  let objects = 0;
  const geos = network.chunks.map(chunk => {
    if (chunk.scene.session_id !== sid || ids.has(chunk.scene.place_id) || !Number.isFinite(chunk.x) || !Number.isFinite(chunk.z)) throw new Error("Connected world sources are inconsistent");
    ids.add(chunk.scene.place_id); parsePlaceScene(chunk.scene.definition); objects += chunk.scene.definition.objects.length;
    const place = sceneGeos(chunk.scene, []).find(geo => geo.id === chunk.scene.place_id)!;
    return { ...place, pos: { x: chunk.x + chunk.scene.definition.width / 2, y: chunk.z + chunk.scene.definition.depth / 2 } };
  });
  if (objects > 1000) throw new Error("Connected export exceeds 1000 objects");
  validateConnections(network.connections, network.chunks.map(chunk => chunk.scene), geos);
  const built = buildConnectedPlaces(network, rootPlaceId);
  try {
    const sourceOrigin = { x: Math.min(...network.chunks.map(chunk => chunk.x)), z: Math.min(...network.chunks.map(chunk => chunk.z)) };
    const places: ConnectedWorldExportManifest["places"] = [];
    const generatedAssets: ConnectedWorldExportManifest["generated_assets"] = [];
    for (const [index, chunk] of built.chunks.entries()) {
      signal.throwIfAborted();
      const part = built.parts[index]!, original = network.chunks[index]!;
      if (part.definition.material_pack === "ankh-street-v1") await applyStreetMaterials(part.scene, signal);
      applyRoofMaterials(part.scene, part.definition);
      await loadSurfaceMaterials(part.scene, part.definition, materialBaseUrl, signal);
      signal.throwIfAborted();
      await loadGeneratedMeshes(part.scene, part.definition, assetBaseUrl, signal);
      signal.throwIfAborted();
      const source = { place_id: chunk.scene.place_id, scene_id: chunk.scene.id, revision: chunk.scene.revision,
        definition_sha256: await digest(new TextEncoder().encode(JSON.stringify(chunk.scene.definition))), label: chunk.scene.definition.label,
        source_origin: { x: original.x, z: original.z }, normalized_origin: { x: chunk.x, z: chunk.z },
        object_ids: chunk.scene.definition.objects.map(object => object.id) };
      places.push(source); part.scene.name = chunk.scene.place_id; part.scene.userData.openflipbook_place = source;
      for (const object of part.definition.objects) {
        const group = part.scene.children.find(child => child.userData.sceneObjectId === object.id);
        if (!group) throw new Error("Saved object geometry is missing from export");
        group.name = `${chunk.scene.place_id}:${object.id}`;
        group.userData.openflipbook_object = { place_id: chunk.scene.place_id, object_id: object.id, entity_id: object.entity_id,
          label: object.label, kind: object.kind, ...(object.asset_id ? { asset_id: object.asset_id } : {}),
          ...(object.placement ? { placement: object.placement } : {}), ...(object.materials ? { materials: object.materials } : {}) };
        if (object.asset_id) {
          const loaded = { place_id: chunk.scene.place_id, object_id: object.id, asset_id: object.asset_id, meshes: 0, vertices: 0 };
          group.traverse(child => {
            if (child instanceof THREE.Mesh && child.userData.generatedMesh === true) { loaded.meshes++; loaded.vertices += child.geometry.getAttribute("position").count; }
          });
          if (!loaded.meshes || !loaded.vertices) throw new Error("Saved generated mesh geometry is missing from export");
          generatedAssets.push(loaded);
        }
      }
    }
    const geometry = { meshes: 0, vertices: 0, triangles: 0, collision_solids: built.solids.length };
    built.scene.updateMatrixWorld(true);
    built.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometry.meshes++; geometry.vertices += object.geometry.getAttribute("position").count;
      geometry.triangles += (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3;
    });
    portableRoofMaterials(built.scene);
    const hemisphere = built.scene.children.find(child => child instanceof THREE.HemisphereLight) as THREE.HemisphereLight | undefined;
    const lighting = hemisphere ? { sky: `#${hemisphere.color.getHexString()}`, ground: `#${hemisphere.groundColor.getHexString()}`, intensity: hemisphere.intensity } : null;
    // Hemisphere ambience has no glTF light primitive. Retain its values for
    // the Blender world adapter instead of exporting an unsupported light.
    hemisphere?.removeFromParent(); hemisphere?.dispose();
    built.scene.traverse(object => {
      if (object instanceof THREE.DirectionalLight) {
        const target = object.target.getWorldPosition(new THREE.Vector3()); object.lookAt(target);
        object.add(object.target); object.target.position.set(0, 0, -1);
      }
      if (object instanceof THREE.Line && object.material instanceof THREE.LineBasicMaterial) {
        const previous = object.material;
        object.material = new THREE.MeshBasicMaterial({ color: previous.color, transparent: previous.transparent, opacity: previous.opacity }); previous.dispose();
      }
    });
    const manifest: ConnectedWorldExportManifest = { format: "openflipbook-connected-glb", version: 1, units: "authored_metres",
      coordinate_system: "right_handed_y_up", session_id: sid, root_place_id: rootPlaceId, source_origin: sourceOrigin,
      bounds: { width: built.definition.width, depth: built.definition.depth,
        occupied_area: built.chunks.reduce((sum, chunk) => sum + chunk.scene.definition.width * chunk.scene.definition.depth, 0) }, places, geometry,
      generated_assets: generatedAssets, lighting };
    built.scene.name = "OpenFlipbook connected world";
    built.scene.userData.openflipbook_world = manifest;
    built.scene.userData.openflipbook_connections = network.connections;
    // These are the actual renderer/physics solids, including traversal limits;
    // invisible boundary colliders are metadata, never invented visible walls.
    built.scene.userData.openflipbook_collision_solids = built.solids;
    const buffer = await new GLTFExporter().parseAsync(built.scene, { binary: true, onlyVisible: false, animations: [] });
    signal.throwIfAborted();
    if (!(buffer instanceof ArrayBuffer)) throw new Error("The full world did not produce a binary glTF");
    const bytes = new Uint8Array(buffer), sha256 = await digest(bytes);
    return { blob: new Blob([buffer], { type: "model/gltf-binary" }), sha256,
      filename: `OpenFlipbook-${rootPlaceId}-connected.glb`, manifest };
  } finally { disposePlace(built.scene); }
}
