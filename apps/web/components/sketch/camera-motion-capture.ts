import * as THREE from "three";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import type { SavedPlaceView, ViewCapture } from "@/lib/place-view";
import { prepareCameraMotion } from "@/lib/camera-motion";
import type { cameraMotionPreview } from "@/lib/camera-motion-server";
import { measureMotionLandmarks } from "@/lib/camera-motion-reference";
import { motionComparisonPlan } from "@/lib/motion-comparison";
import { createCameraPathChecker } from "@/lib/camera-path-check";
import { cameraCollisionSurfaces } from "./camera-collision-surfaces";
import { savedViewCamera, withPlaceViewScene } from "./place-view-refresh";
import { capturePlaceView } from "./place-view-capture";

export type MotionPreparation = Awaited<ReturnType<typeof cameraMotionPreview>>;
export type MotionReferenceCapture = Awaited<ReturnType<typeof captureMotionReferences>>;

function sameReferenceCameras(a: MotionPreparation["reference_cameras"], b: MotionPreparation["reference_cameras"]) {
  // Linux provider preparation and a macOS browser can differ in sin/cos by
  // a few ulps. Allow numerical roundoff, not a different pose or projection.
  const close = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-10 * Math.max(1, Math.abs(x), Math.abs(y));
  const values = (x: number[], y: number[]) => x.length === y.length && x.every((n, i) => close(n, y[i]!));
  return a.length === b.length && a.every((frame, i) => {
    const other = b[i]!;
    return frame.time === other.time && frame.seconds === other.seconds && values(frame.position, other.position)
      && values(frame.world_matrix, other.world_matrix) && values(frame.projection_matrix, other.projection_matrix);
  });
}

export async function captureMotionReferences(renderer: THREE.WebGLRenderer, view: SavedPlaceView,
  snapshot: PlaceSceneSnapshot, preparation: MotionPreparation,
  storage: { mesh?: string | undefined; material?: string | undefined }, signal: AbortSignal) {
  signal.throwIfAborted();
  const binding = preparation.source.sources[0];
  if (view.historical || preparation.source.view_id !== view.id || !view.path || view.path.time !== 0
    || preparation.source.sources.length !== 1 || !binding || binding.x !== 0 || binding.z !== 0
    || binding.scene_id !== snapshot.id || binding.place_id !== snapshot.place_id || binding.revision !== snapshot.revision
    || JSON.stringify(view.sources) !== JSON.stringify(preparation.source.sources)
    || JSON.stringify(view.assets) !== JSON.stringify(preparation.source.assets)) throw new Error("Motion reference sources changed");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot.definition)));
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== binding.definition_sha256) throw new Error("Save the exact prepared scene before capturing motion");
  signal.throwIfAborted();
  return withPlaceViewScene(view, snapshot, null, storage, signal, async (scene, sources, solids) => {
    const metadata: ViewCapture = { ...view, sources, passes: { render: "", depth: "", normals: "", objects: "" } };
    const local = prepareCameraMotion(metadata);
    if (local.adapter !== preparation.adapter || JSON.stringify(local.parameters) !== JSON.stringify(preparation.parameters)
      || !sameReferenceCameras(local.reference_cameras, preparation.reference_cameras)
      || JSON.stringify(local.path) !== JSON.stringify(preparation.path)) throw new Error("Prepared camera path changed");
    const checker = await createCameraPathChecker(solids, cameraCollisionSurfaces(scene));
    try {
      signal.throwIfAborted();
      // Perspective near-plane corners derive from the pinned projection, not
      // the default FOV properties of a reconstructed Three.js camera.
      const p = view.camera.projection_matrix, near = view.camera.near;
      const clearance = Math.max(0.2, Math.hypot(near, near / p[0]!, near / p[5]!));
      const preflight = checker.check(local.path.keyframes, new THREE.Vector3(...local.path.pivot), clearance, local.path.target_id!);
      const frames: { time: number; seconds: number; capture: ViewCapture; measurements: ReturnType<typeof measureMotionLandmarks> }[] = [];
      let bytes = 0;
      for (const reference of local.reference_cameras) {
        signal.throwIfAborted();
        const camera = savedViewCamera({ ...view.camera, world_matrix: reference.world_matrix, projection_matrix: reference.projection_matrix });
        let measurements: ReturnType<typeof measureMotionLandmarks> | undefined;
        const shadows = renderer.shadowMap.needsUpdate;
        let capture: ViewCapture;
        try {
          renderer.shadowMap.needsUpdate = true;
          capture = capturePlaceView(renderer, scene, camera, sources, "orbit", undefined, view,
            (rgba, width, height) => { measurements = measureMotionLandmarks(rgba, width, height, view.objects); });
        } finally { renderer.shadowMap.needsUpdate = shadows; }
        if (!measurements) throw new Error("Motion object-mask measurements are missing");
        bytes += Object.values(capture.passes).reduce((sum, value) => sum + value.length, 0);
        if (bytes > 64 * 1024 * 1024) throw new Error("Motion reference images exceed 64 MiB");
        frames.push({ time: reference.time, seconds: reference.seconds, capture, measurements });
        // Yield between complete captures so navigation/cancellation can run.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      signal.throwIfAborted();
      const comparison = motionComparisonPlan({ preparation: local,
        source: { view, definitions: sources }, frames });
      return { version: 1 as const, preparation_sha256: preparation.preparation_sha256,
        provenance: "local_geometry_reference_not_provider_video" as const, preflight, frames, comparison };
    } finally { checker.free(); }
  });
}

export async function captureMotionReferencesOffscreen(view: SavedPlaceView, snapshot: PlaceSceneSnapshot,
  preparation: MotionPreparation, storage: { mesh?: string | undefined; material?: string | undefined }, signal: AbortSignal) {
  signal.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; renderer.outputColorSpace = THREE.SRGBColorSpace;
    return await captureMotionReferences(renderer, view, snapshot, preparation, storage, signal);
  } finally { renderer.dispose(); renderer.forceContextLoss(); }
}
