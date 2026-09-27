import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import { validateMeshGlb } from "@/lib/mesh-asset";
import { disposePlace } from "./place-scene-renderer";
import { fitGeneratedMesh } from "@/lib/mesh-transform";
export { fitGeneratedMesh } from "@/lib/mesh-transform";

export async function loadGeneratedMeshes(scene: THREE.Scene, definition: PlaceSceneDefinition, base: string | undefined, signal: AbortSignal) {
  for (const object of definition.objects.filter(o => o.asset_id)) {
    if (!base || !object.asset_id) throw new Error("Generated mesh storage is unavailable");
    const response = await fetch(`${base}/${encodeURIComponent(object.asset_id)}`, {signal});
    if (!response.ok) throw new Error("Saved mesh could not be loaded");
    const bytes = await response.arrayBuffer(); validateMeshGlb(new Uint8Array(bytes));
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    if (signal.aborted) { const discarded = new THREE.Scene(); discarded.add(gltf.scene); disposePlace(discarded); return; }
    try {
      const parent = scene.children.find(child => child.userData.meshObjectId === object.id);
      if (!parent) throw new Error("Mesh placement is missing");
      const fitted = fitGeneratedMesh(gltf.scene, object);
      fitted.visible = parent.userData.hideMesh !== true;
      parent.add(fitted);
    } catch (error) {
      const discarded = new THREE.Scene(); discarded.add(gltf.scene); disposePlace(discarded);
      throw error;
    }
  }
}
