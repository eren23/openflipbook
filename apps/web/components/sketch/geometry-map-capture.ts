import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView } from "@/lib/place-view";
import { THREE } from "./place-scene-renderer";
import { refreshPlaceViewOffscreen } from "./place-view-refresh";

export function geometryMapCamera(snapshot: PlaceSceneSnapshot): SavedPlaceView {
  const { width, depth } = snapshot.definition, extent = Math.max(width, depth), half = extent * 0.55;
  const height = extent * 2 + Math.max(0, ...snapshot.definition.objects.map(o => o.height));
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, height + extent * 4);
  camera.position.set(width / 2, height, depth / 2); camera.up.set(0, 0, -1); camera.lookAt(width / 2, 0, depth / 2);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return { id: "map_capture", label: "Map artwork", created_at: new Date().toISOString(), root_place_id: snapshot.place_id, historical: false,
    version: 1, mode: "plan", purpose: "map", floor_id: null, width: 768, height: 768,
    camera: { projection: "orthographic", world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray(), near: camera.near, far: camera.far },
    depth: { encoding: "linear_view_z_8bit_near_white", near: camera.near, far: camera.far }, normals: "view_space_rgb", surface_policy: "opaque_geometry",
    objects: [], assets: [], provenance: "client_rendered_saved_geometry",
    sources: [{ scene_id: snapshot.id, place_id: snapshot.place_id, revision: snapshot.revision, x: 0, z: 0, definition_sha256: "" }] };
}
export async function captureGeometryMap(snapshot: PlaceSceneSnapshot, storage: { mesh: string; material: string }, signal: AbortSignal, previous?: SavedPlaceView) {
  if (previous && previous.purpose !== "map") throw new Error("Refresh a saved map camera");
  return refreshPlaceViewOffscreen(previous ?? geometryMapCamera(snapshot), snapshot, null, storage, signal);
}
