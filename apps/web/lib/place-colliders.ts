import type RAPIER from "@dimforge/rapier3d-compat";
import type {Solid} from "./place-physics";

export function placeCollider(R: typeof RAPIER, solid: Solid) {
  const w=solid.w/2, h=solid.h/2, d=solid.d/2;
  const collider = solid.ramp ? R.ColliderDesc.convexHull(new Float32Array([
    -w,-h,-d, w,-h,-d, -w,-h,d, w,-h,d, -w,h,-d, w,h,-d,
  ])) : R.ColliderDesc.cuboid(w,h,d);
  if (!collider) throw new Error("Invalid stair collision geometry");
  return collider.setTranslation(solid.x,solid.y,solid.z).setRotation({x:0,y:Math.sin(solid.yaw/2),z:0,w:Math.cos(solid.yaw/2)});
}
