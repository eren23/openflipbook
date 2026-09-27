import { PerspectiveCamera, Vector3 } from "three";
import receipt from "@/public/demos/ankh-morpork/alignment-fit.json";
import type { PlaceSceneDefinition } from "@openflipbook/config";

export type AlignmentProfile = "original" | "vertical_only" | "free_camera" | "shape_fit";
export const DRUM_ALIGNMENT = receipt;
export function alignmentResult(profile: AlignmentProfile) {
  return receipt.results.find(result => result.name === profile)!;
}
export function alignmentCamera(profile: AlignmentProfile) {
  const [x, y, z, yaw, pitch, fov] = alignmentResult(profile).parameters;
  const camera = new PerspectiveCamera(fov, receipt.observations.width / receipt.observations.height, 0.05, 400);
  camera.position.set(x!, y!, z!);
  camera.lookAt(x! + Math.cos(pitch!) * Math.cos(yaw!), y! + Math.sin(pitch!), z! + Math.cos(pitch!) * Math.sin(yaw!));
  camera.updateMatrixWorld();
  return camera;
}
export function alignedDrumScene(source: PlaceSceneDefinition, profile: AlignmentProfile) {
  const parameters = alignmentResult(profile).parameters;
  const definition = structuredClone(source);
  const tavern = definition.objects.find(object => object.kind === "tavern")!;
  tavern.height = parameters[7]!;
  tavern.eave_height = parameters[6]!;
  if (profile === "shape_fit") {
    // Keep the front wall at Z=13; only the rear envelope expands.
    tavern.depth = parameters[8]!; tavern.z = 13 + tavern.depth / 2;
    tavern.roof_offset = parameters[9]!;
    const back = 13 + tavern.depth;
    const yard = definition.objects.find(object => object.label === "Rear yard");
    if (yard) { yard.depth = 21.2 - back - 0.2; yard.z = (21.2 + back + 0.2) / 2; }
    const wall = definition.objects.find(object => object.label === "Yard west wall");
    if (wall) { wall.width = 21.5 - back - 0.1; wall.z = (21.5 + back + 0.1) / 2; }
  }
  return { definition, eaveHeights: { [tavern.id]: parameters[6]! } };
}
export function alignmentPoints(profile: AlignmentProfile) {
  const parameters = alignmentResult(profile).parameters, camera = alignmentCamera(profile);
  return receipt.observations.anchors.map(anchor => {
    const point = new Vector3(...anchor.point as [number, number, number]);
    if ("height" in anchor) point.y = parameters[anchor.height === "eave" ? 6 : 7]!;
    if (profile === "shape_fit" && anchor.id === "rear_eave") point.z = 13 + parameters[8]!;
    if (profile === "shape_fit" && anchor.id === "roof_ridge") point.x = 13 + parameters[9]!;
    point.project(camera);
    const pixel = [(point.x + 1) / 2 * receipt.observations.width, (1 - point.y) / 2 * receipt.observations.height];
    return { ...anchor, projected: pixel, error: Math.hypot(pixel[0]! - anchor.pixel[0]!, pixel[1]! - anchor.pixel[1]!) };
  });
}
