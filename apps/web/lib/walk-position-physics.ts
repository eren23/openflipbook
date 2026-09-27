import type RAPIER from "@dimforge/rapier3d-compat";

export function walkPositionClear(R: typeof RAPIER, world: RAPIER.World, position: RAPIER.Vector, exclude?: RAPIER.Collider) {
  if (![position.x,position.y,position.z].every(Number.isFinite)) return false;
  const rotation = {x:0,y:0,z:0,w:1};
  // Slightly shrink the query capsule to tolerate Rapier's contact skin, while
  // requiring nearby support rather than restoring a position in mid-air.
  const capsule = new R.Capsule(0.5,0.29);
  if (world.intersectionWithShape(position,rotation,capsule,undefined,undefined,exclude)) return false;
  return !!world.castShape(position,rotation,{x:0,y:-1,z:0},capsule,0,0.3,true,undefined,undefined,exclude);
}
