// @vitest-environment node
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { beforeEach, expect, it, vi } from "vitest";
import type { MeshAssetDoc } from "./mesh-execution";
vi.mock("./r2", () => ({ getStoredBytes: vi.fn() }));
vi.mock("./creator", () => ({ CreatorError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
import { savedMeshDimensions } from "./mesh-geometry-server";
import { getStoredBytes } from "./r2";
import { fixtureGlb } from "../e2e/fixtures/mesh-glb";

const bytes = fixtureGlb(), sha256 = createHash("sha256").update(bytes).digest("hex");
let asset: MeshAssetDoc;
const update = vi.fn(async (query: { sha256: string }, patch: { $set: Partial<MeshAssetDoc> }) => { if (query.sha256 === asset.sha256) Object.assign(asset, patch.$set); });
const db = { collection: () => ({ findOne: async (query: { _id: string; session_id: string }) => query._id === asset._id && query.session_id === asset.session_id ? structuredClone(asset) : null, updateOne: update }) } as unknown as Db;
beforeEach(() => {
  asset = { _id: "world:mesh1", id: "mesh1", session_id: "world", key: "immutable.glb", sha256, bytes: bytes.length, model: "fixture", prompt: "fixture", request_id: "request", created_at: new Date() };
  update.mockClear(); vi.mocked(getStoredBytes).mockReset();
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes, contentType: "model/gltf-binary" });
});
it("measures verified bytes once and caches only against their immutable hash", async () => {
  expect(await savedMeshDimensions(db, "world", "mesh1")).toEqual({ width: 2, height: 4, depth: 3 });
  expect(asset.geometry).toEqual({ sha256, size: { width: 2, height: 4, depth: 3 } });
  expect(update.mock.calls[0]?.[0]).toEqual({ _id: asset._id, sha256 });
  await savedMeshDimensions(db, "world", "mesh1"); expect(getStoredBytes).toHaveBeenCalledTimes(1);
});
it("does not reuse bounds from a different hash", async () => {
  asset.geometry = { sha256: "other", size: { width: 99, height: 99, depth: 99 } };
  expect(await savedMeshDimensions(db, "world", "mesh1")).toEqual({ width: 2, height: 4, depth: 3 });
  expect(getStoredBytes).toHaveBeenCalledTimes(1);
});
it("rejects foreign ownership scope and invalid IDs before reading storage", async () => {
  await expect(savedMeshDimensions(db, "other", "mesh1")).rejects.toMatchObject({ status: 404 });
  await expect(savedMeshDimensions(db, "world", "../mesh1")).rejects.toMatchObject({ status: 400 });
  expect(getStoredBytes).not.toHaveBeenCalled();
});
it("never caches missing, corrupt, or unmeasurable geometry", async () => {
  vi.mocked(getStoredBytes).mockResolvedValue(null);
  await expect(savedMeshDimensions(db, "world", "mesh1")).rejects.toMatchObject({ status: 503 });
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: Buffer.from("corrupt"), contentType: "model/gltf-binary" });
  await expect(savedMeshDimensions(db, "world", "mesh1")).rejects.toMatchObject({ status: 503 });
  asset.sha256 = createHash("sha256").update("corrupt").digest("hex");
  await expect(savedMeshDimensions(db, "world", "mesh1")).rejects.toMatchObject({ status: 422 });
  expect(update).not.toHaveBeenCalled();
});
