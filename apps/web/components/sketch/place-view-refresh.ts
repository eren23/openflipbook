import type { PlaceNetwork, PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView, ViewCapture } from "@/lib/place-view";
import { buildPlaceScene, disposePlace, THREE } from "./place-scene-renderer";
import { buildConnectedPlaces } from "./connected-place-renderer";
import { applyRoofMaterials, applyStreetMaterials } from "./street-materials";
import { loadSurfaceMaterials } from "./surface-materials";
import { loadGeneratedMeshes } from "./generated-mesh";
import { capturePlaceView } from "./place-view-capture";
import type { Solid } from "@/lib/place-physics";

export async function refreshPlaceViewOffscreen(view: SavedPlaceView, snapshot: PlaceSceneSnapshot,
  network: PlaceNetwork | null | undefined, storage: { mesh?: string | undefined; material?: string | undefined }, signal: AbortSignal): Promise<ViewCapture> {
  signal.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; renderer.outputColorSpace = THREE.SRGBColorSpace;
    return await refreshPlaceView(renderer, view, snapshot, network, storage, signal);
  } finally { renderer.dispose(); renderer.forceContextLoss(); }
}

export async function refreshPlaceView(renderer: THREE.WebGLRenderer, view: SavedPlaceView,
  snapshot: PlaceSceneSnapshot, network: PlaceNetwork | null | undefined,
  storage: { mesh?: string | undefined; material?: string | undefined }, signal: AbortSignal): Promise<ViewCapture> {
  return withPlaceViewScene(view, snapshot, network, storage, signal, async (scene, sources) => {
    const camera = savedViewCamera(view.camera);
    const shadows = renderer.shadowMap.needsUpdate;
    try {
      renderer.shadowMap.needsUpdate = true;
      return capturePlaceView(renderer, scene, camera, sources, view.mode, view.floor_id ?? undefined, view);
    } finally { renderer.shadowMap.needsUpdate = shadows; }
  });
}

export function savedViewCamera(saved: SavedPlaceView["camera"]) {
  const camera = saved.projection === "perspective" ? new THREE.PerspectiveCamera() : new THREE.OrthographicCamera();
  camera.near = saved.near; camera.far = saved.far;
  // Replay exact saved projection, never the current viewport's aspect or lens.
  camera.matrixAutoUpdate = false;
  camera.matrix.fromArray(saved.world_matrix);
  camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
  camera.projectionMatrix.fromArray(saved.projection_matrix);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld(true);
  return camera;
}

export async function withPlaceViewScene<T>(view: SavedPlaceView, snapshot: PlaceSceneSnapshot,
  network: PlaceNetwork | null | undefined,
  storage: { mesh?: string | undefined; material?: string | undefined }, signal: AbortSignal,
  run: (scene: THREE.Scene, sources: ViewCapture["sources"], solids: Solid[]) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (view.root_place_id !== snapshot.place_id || !view.sources.some(s => s.place_id === snapshot.place_id && s.scene_id === snapshot.id)) throw new Error("Saved camera belongs to a different place");
  if (view.floor_id && !snapshot.definition.objects.some(o => o.structure?.floors.some(f => f.id === view.floor_id))) throw new Error("The saved camera floor no longer exists");
  const connected = view.mode === "walk" && network ? buildConnectedPlaces(network, snapshot.place_id) : null;
  const { scene, solids } = connected ?? buildPlaceScene(snapshot.definition, { cutaway: view.mode === "plan", floorId: view.floor_id ?? undefined });
  try {
    for (const part of connected?.parts ?? [{ scene, definition: snapshot.definition }]) {
      if (part.definition.material_pack === "ankh-street-v1") await applyStreetMaterials(part.scene, signal);
      signal.throwIfAborted();
      applyRoofMaterials(part.scene, part.definition);
      await loadSurfaceMaterials(part.scene, part.definition, storage.material, signal);
      signal.throwIfAborted();
      await loadGeneratedMeshes(part.scene, part.definition, storage.mesh, signal);
      signal.throwIfAborted();
    }
    const sources = (connected?.chunks ?? [{ scene: snapshot, x: 0, z: 0 }]).map(({ scene: source, x, z }) => ({ scene_id: source.id, place_id: source.place_id, revision: source.revision, definition: source.definition, x, z }));
    return await run(scene, sources, solids);
  } finally { disposePlace(scene); }
}
