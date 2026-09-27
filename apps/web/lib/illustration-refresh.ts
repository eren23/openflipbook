import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { CreatorError } from "./creator-error";
import type { SavedPlaceView, ViewPass } from "./place-view";
import { pixelBytesHash, registeredPixels } from "./illustration-region";

export function assertRefreshCamera(before: SavedPlaceView | Omit<SavedPlaceView, "historical">, after: typeof before) {
  if (after.refreshed_from !== before.id || before.root_place_id !== after.root_place_id
    || before.width !== after.width || before.height !== after.height || before.mode !== after.mode
    || before.floor_id !== after.floor_id || before.surface_policy !== after.surface_policy
    || !isDeepStrictEqual(before.camera, after.camera)) throw new CreatorError("Artwork refresh requires the same registered camera and its saved predecessor", 409);
}

type Capture = Pick<SavedPlaceView, "width" | "height" | "objects" | "depth">;
export async function composeGeometryRefresh(base: Buffer, proposal: Buffer, before: Capture, after: Capture,
  oldPasses: Record<ViewPass, Buffer>, newPasses: Record<ViewPass, Buffer>) {
  const { width, height } = after;
  if (before.width !== width || before.height !== height) throw new CreatorError("Refresh dimensions differ", 409);
  const old: Partial<Record<ViewPass, Buffer>> = {}, fresh: typeof old = {};
  for (const pass of ["render", "depth", "normals", "objects"] as const) {
    old[pass] = await registeredPixels(oldPasses[pass], width, height, true);
    fresh[pass] = await registeredPixels(newPasses[pass], width, height, true);
  }
  const labels = (view: Capture) => new Map([[0, ""], ...view.objects.map(o => [o.rgb[0] * 65536 + o.rgb[1] * 256 + o.rgb[2], o.object_id] as [number, string])]);
  const oldLabels = labels(before), newLabels = labels(after);
  const idAt = (data: Buffer, i: number, ids: Map<number, string>) => {
    const id = ids.get(data[i]! * 65536 + data[i + 1]! * 256 + data[i + 2]!);
    if (id === undefined || data[i + 3] !== 255) throw new CreatorError("Refresh mask has unregistered object pixels", 409);
    return id;
  };
  const depths = [before.depth, after.depth];
  if (depths.some(d => !Number.isFinite(d.near) || !Number.isFinite(d.far) || d.far <= d.near)) throw new CreatorError("Invalid saved depth range", 409);
  const depthAt = (value: number, view: Capture) => view.depth.near + (1 - value / 255) * (view.depth.far - view.depth.near);
  const depthTolerance = depths.reduce((sum, d) => sum + (d.far - d.near) / 510, 0) + 1e-6;
  const delta = Buffer.alloc(width * height);
  const differs = (a: Buffer, b: Buffer, i: number) => a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3];
  for (let p = 0; p < delta.length; p++) {
    const i = p * 4;
    // Compare semantic identities, not mask colors: object order can change.
    const changedId = idAt(old.objects!, i, oldLabels) !== idAt(fresh.objects!, i, newLabels);
    const changedPass = differs(old.render!, fresh.render!, i) || differs(old.normals!, fresh.normals!, i);
    const hasSurface = old.normals![i] || old.normals![i + 1] || old.normals![i + 2] || fresh.normals![i] || fresh.normals![i + 1] || fresh.normals![i + 2];
    const changedDepth = hasSurface && Math.abs(depthAt(old.depth![i]!, before) - depthAt(fresh.depth![i]!, after)) > depthTolerance;
    if (changedId || changedPass || changedDepth) delta[p] = 255;
  }
  // Two pixels cover the transition edge without feathering protected artwork.
  const mask = Buffer.from(delta);
  for (let p = 0; p < delta.length; p++) if (delta[p]) {
    const x = p % width, y = Math.floor(p / width);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) mask[(y + dy) * width + x + dx] = 255;
  }
  const changed_pixels = mask.reduce((n, value) => n + (value ? 1 : 0), 0), protected_pixels = width * height - changed_pixels;
  if (!changed_pixels) throw new CreatorError("The saved captures have no visible changes to refresh", 409);
  if (!protected_pixels) throw new CreatorError("Refresh would replace the entire image; review a full illustration instead", 409);
  const output = await registeredPixels(base, width, height), source = await registeredPixels(proposal, width, height);
  for (let p = 0; p < mask.length; p++) if (mask[p]) source.copy(output, p * 4, p * 4, p * 4 + 4);
  return { bytes: await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    mask_sha256: pixelBytesHash(mask), changed_pixels, protected_pixels };
}
