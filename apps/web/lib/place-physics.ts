import type RAPIER from "@dimforge/rapier3d-compat";

let initialization: Promise<typeof RAPIER> | undefined;
export interface Solid { x: number; y: number; z: number; w: number; h: number; d: number; yaw: number; ramp?: boolean }

// Concurrent mount effects must share one WASM initialization. Reinitializing it
// can invalidate an already-created world's pointers during the first frame.
export function loadPlacePhysics() {
  initialization ??= import("@dimforge/rapier3d-compat").then(async ({ default: physics }) => {
    await physics.init();
    return physics;
  }).catch(error => { initialization = undefined; throw error; });
  return initialization;
}
