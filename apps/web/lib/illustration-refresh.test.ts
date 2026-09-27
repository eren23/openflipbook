import { expect, it } from "vitest";
import sharp from "sharp";
import { assertRefreshCamera, composeGeometryRefresh } from "./illustration-refresh";
import { registeredPixels } from "./illustration-region";
import type { SavedPlaceView, ViewPass } from "./place-view";

const view = { width: 32, height: 32, objects: [{ object_id: "roof", rgb: [1, 2, 3] as [number, number, number] }], depth: { encoding: "linear_view_z_8bit_near_white" as const, near: 1, far: 11 } };
const rgba = (color: number[]) => { const bytes = Buffer.alloc(4096); for (let p = 0; p < 1024; p++) bytes.set(color, p * 4); return bytes; };
const png = (bytes: Buffer) => sharp(bytes, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
async function passes(raw: Record<ViewPass, Buffer>) {
  const result = {} as Record<ViewPass, Buffer>;
  for (const pass of ["render", "objects", "depth", "normals"] as const) result[pass] = await png(raw[pass]);
  return result;
}
function fixture() {
  return { render: rgba([20, 30, 40, 255]), objects: rgba([0, 0, 0, 255]), depth: rgba([128, 128, 128, 255]), normals: rgba([128, 255, 128, 255]) };
}
it("refreshes both sides of a move and changed shadows, preserving every other decoded RGBA pixel", async () => {
  const old = fixture(), fresh = fixture(), base = rgba([10, 20, 30, 100]), proposal = rgba([150, 160, 170, 255]);
  old.objects.set([1, 2, 3, 255], (10 * 32 + 10) * 4);
  fresh.objects.set([4, 5, 6, 255], (10 * 32 + 15) * 4);
  fresh.render.set([1, 2, 3, 255], (20 * 32 + 20) * 4);
  const after = { ...view, objects: [{ object_id: "roof", rgb: [4, 5, 6] as [number, number, number] }] };
  const result = await composeGeometryRefresh(await png(base), await png(proposal), view, after, await passes(old), await passes(fresh));
  expect(result).toMatchObject({ changed_pixels: 75, protected_pixels: 949, mask_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const decoded = await registeredPixels(result.bytes, 32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const changed = y >= 8 && y <= 12 && x >= 8 && x <= 17 || y >= 18 && y <= 22 && x >= 18 && x <= 22;
    expect([...decoded.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]).toEqual(changed ? [150, 160, 170, 255] : [10, 20, 30, 100]);
  }
});
it("does not mistake mask recoloring or depth-range changes for changed geometry or sky", async () => {
  const old = fixture(), fresh = fixture();
  old.objects.set([1, 2, 3, 255], 0); fresh.objects.set([4, 5, 6, 255], 0);
  // The same surface rounds to different bytes when the depth range doubles.
  old.depth = rgba([128, 128, 128, 255]); fresh.depth = rgba([192, 192, 192, 255]);
  old.normals.set([0, 0, 0, 255], 4); fresh.normals.set([0, 0, 0, 255], 4);
  old.depth.set([0, 0, 0, 255], 4); fresh.depth.set([0, 0, 0, 255], 4);
  const after = { ...view, depth: { ...view.depth, far: 21 }, objects: [{ object_id: "roof", rgb: [4, 5, 6] as [number, number, number] }] };
  const base = await png(old.render);
  await expect(composeGeometryRefresh(base, base, view, after, await passes(old), await passes(fresh))).rejects.toThrow("no visible changes");
  fresh.depth.set([200, 200, 200, 255], (16 * 32 + 16) * 4);
  expect(await composeGeometryRefresh(base, base, view, after, await passes(old), await passes(fresh))).toMatchObject({ changed_pixels: 25, protected_pixels: 999 });
});
it("rejects unregistered masks, corrupt inputs and full-frame replacements", async () => {
  const old = fixture(), fresh = fixture(), base = await png(old.render), oldPasses = await passes(old);
  fresh.objects.set([3, 2, 1, 255], 0);
  await expect(composeGeometryRefresh(base, base, view, view, oldPasses, await passes(fresh))).rejects.toThrow("unregistered");
  fresh.objects = old.objects; fresh.render = rgba([0, 0, 0, 255]);
  await expect(composeGeometryRefresh(base, base, view, view, oldPasses, await passes(fresh))).rejects.toThrow("entire image");
  await expect(composeGeometryRefresh(base, base, view, view, { ...oldPasses, objects: Buffer.from("broken") }, oldPasses)).rejects.toThrow("decode");
});
it("requires a direct predecessor with identical framing and floor", () => {
  const before: SavedPlaceView = { ...view, id: "old", root_place_id: "place", version: 1, mode: "orbit", floor_id: null,
    camera: { projection: "perspective", world_matrix: [], projection_matrix: [], near: 0.1, far: 100 },
    normals: "view_space_rgb", surface_policy: "opaque_geometry", sources: [], assets: [], label: "Before", created_at: "now", historical: true, provenance: "client_rendered_saved_geometry" };
  const after = { ...before, id: "new", refreshed_from: before.id };
  expect(() => assertRefreshCamera(before, after)).not.toThrow();
  for (const patch of [{ refreshed_from: "foreign" }, { width: 64 }, { root_place_id: "other" }, { floor_id: "upstairs" }, { camera: { ...before.camera, far: 200 } }]) expect(() => assertRefreshCamera(before, { ...after, ...patch })).toThrow("same registered camera");
});
