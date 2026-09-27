// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
const storage = vi.hoisted(() => ({ bytes: null as Buffer | null }));
vi.mock("./r2", () => ({ getStoredBytes: vi.fn(async () => storage.bytes ? { bytes: storage.bytes } : null) }));
import { validateMeshShells } from "./mesh-shell-server";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { fixtureShellGlb } from "../e2e/fixtures/mesh-shell";
import { getStoredBytes } from "./r2";
const object = { ...newComponent("building", 20, 20), asset_id: "mesh", mesh_scale: "uniform" as const };
object.structure!.windows = [];
const definition = { ...emptyPlaceScene(), objects: [object] };
function db(owned = true, hash = storage.bytes ? createHash("sha256").update(storage.bytes).digest("hex") : "missing") {
  return { collection: () => ({ findOne: async (query: { _id: string; session_id: string }) => owned && query._id === "world:mesh" && query.session_id === "world" ? { _id: "world:mesh", key: "private.glb", sha256: hash } : null }) } as unknown as Db;
}
beforeEach(() => { storage.bytes = null; vi.clearAllMocks(); });
it("validates exact owned, hash-pinned textured GLB bytes without a provider or writable client receipt", async () => {
  storage.bytes = fixtureShellGlb(object); const before = Buffer.from(storage.bytes);
  expect(await validateMeshShells(db(), "world", definition)).toEqual([expect.stringContaining("mesh shell validated")]); expect(storage.bytes).toEqual(before);
});
it("rejects closed facades, missing files, corrupt bytes and foreign asset bindings", async () => {
  storage.bytes = fixtureShellGlb(object, true); await expect(validateMeshShells(db(), "world", definition)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("blocks shell free space") });
  await expect(validateMeshShells(db(false), "world", definition)).rejects.toMatchObject({ status: 403 });
  await expect(validateMeshShells(db(), "foreign", definition)).rejects.toMatchObject({ status: 403 });
  await expect(validateMeshShells(db(true, "wrong"), "world", definition)).rejects.toMatchObject({ status: 503 });
  storage.bytes = null; await expect(validateMeshShells(db(), "world", definition)).rejects.toMatchObject({ status: 503 });
});
it("does not reinterpret ordinary solid meshes or make storage calls for authored-only shells", async () => {
  const { structure: _structure, ...mesh } = object, { asset_id: _asset, mesh_scale: _scale, ...authored } = object;
  expect(await validateMeshShells(db(), "world", { ...definition, objects: [{ ...mesh, kind: "mesh" }] })).toEqual([]);
  expect(await validateMeshShells(db(), "world", { ...definition, objects: [authored] })).toEqual([]);
  expect(getStoredBytes).not.toHaveBeenCalled();
});
