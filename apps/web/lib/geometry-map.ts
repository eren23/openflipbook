import { Matrix4, Vector3 } from "three";
import type { ViewCapture } from "./place-view";

/** Exact camera registration for a complete exterior map, separate from imported artwork's manual fit. */
export function assertGeometryMapCapture(view: Pick<ViewCapture, "mode" | "floor_id" | "camera" | "sources">) {
  if (view.mode !== "plan" || view.floor_id !== null || view.camera.projection !== "orthographic" || view.sources.length !== 1) throw new Error("Map artwork requires a single-place exterior plan camera");
  const m = view.camera.world_matrix;
  if (Math.abs(m[8]!) > 1e-6 || Math.abs(m[10]!) > 1e-6 || Math.abs(m[9]! - 1) > 1e-6) throw new Error("Map artwork requires a camera looking straight down");
  const source = view.sources[0]!, projection = new Matrix4().fromArray(view.camera.projection_matrix).multiply(new Matrix4().fromArray(m).invert());
  const height = Math.max(0, ...source.definition.objects.map(o => o.height));
  for (const x of [0, source.definition.width]) for (const z of [0, source.definition.depth]) for (const y of [0, height]) {
    const p = new Vector3(source.x + x, y, source.z + z).applyMatrix4(projection);
    if (![p.x, p.y, p.z].every(Number.isFinite) || Math.abs(p.x) > 1 + 1e-6 || Math.abs(p.y) > 1 + 1e-6 || Math.abs(p.z) > 1 + 1e-6) throw new Error("The saved map camera must contain the whole place");
  }
}
