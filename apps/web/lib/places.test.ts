import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldEntityGeo } from "@openflipbook/config";

const mocks = vi.hoisted(() => ({ map: vi.fn(), node: vi.fn(), mapWrite: vi.fn(), entityWrite: vi.fn(), bytes: vi.fn(), transaction: vi.fn() }));
vi.mock("./r2", () => ({ getStoredBytes: mocks.bytes }));
vi.mock("./db", () => ({ withDbTransaction: mocks.transaction }));
import { updatePlace } from "./places";

const version = "2026-09-06T00:00:00.000Z";
const bbox = { x_pct: 0, y_pct: 0, w_pct: 1, h_pct: 1 };
const place: WorldEntityGeo = { id: "tower", entity_id: "entity", kind: "place", label: "Tower", visual: "stone", footprint: { w: 8, d: 8 }, height: 4, pos: { x: 30, y: 30 }, state: {}, confidence: 1, source: "user", updated_at: version };
const session = {};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.map.mockResolvedValue({ _id: "world", entities: [place], updated_at: new Date(version) });
  mocks.node.mockResolvedValue({ _id: "node", session_id: "world", image_key: "current.png" });
  mocks.bytes.mockResolvedValue({ contentType: "image/png", bytes: Buffer.from("image") });
  mocks.transaction.mockImplementation(async run => run({ collection: (name: string) => name === "world_map" ? { findOne: mocks.map, updateOne: mocks.mapWrite } : name === "nodes" ? { findOne: mocks.node } : { updateOne: mocks.entityWrite } }, session));
});

describe("curated place writes", () => {
  it("updates geometry and linked Codex fields in the same transaction", async () => {
    const next = await updatePlace("world", "tower", { expected_updated_at: version, label: " North Tower ", visual: "granite", identity_locked: true });
    expect(next.label).toBe("North Tower"); expect(next.pos).toEqual(place.pos);
    expect(mocks.mapWrite.mock.calls[0]![2]).toEqual({ session });
    expect(mocks.entityWrite.mock.calls[0]![2]).toEqual({ session });
    expect(mocks.entityWrite.mock.calls[0]![1]).toMatchObject({ $set: { "entities.$.name": "North Tower", "entities.$.pinned_by_user": true }, $addToSet: { "entities.$.aliases": "Tower" } });
  });
  it("rejects a stale write before updating either store", async () => {
    await expect(updatePlace("world", "tower", { expected_updated_at: "2026-01-01T00:00:00.000Z", label: "stale" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.mapWrite).not.toHaveBeenCalled(); expect(mocks.entityWrite).not.toHaveBeenCalled();
  });
  it("rejects a reference outside this world before any write", async () => {
    mocks.node.mockResolvedValue(null);
    await expect(updatePlace("world", "tower", { expected_updated_at: version, reference: { node_id: "foreign", bbox } })).rejects.toMatchObject({ status: 404 });
    expect(mocks.node).toHaveBeenCalledWith({ _id: "foreign", session_id: "world" }, { session });
    expect(mocks.mapWrite).not.toHaveBeenCalled();
  });
  it("stores immutable bytes and does not unpin on a reference-only change", async () => {
    const next = await updatePlace("world", "tower", { expected_updated_at: version, reference: { node_id: "node", bbox } });
    expect(next.identity_anchor).toEqual({ node_id: "node", image_key: "current.png", bbox });
    expect(mocks.entityWrite.mock.calls[0]![1].$set).not.toHaveProperty("entities.$.pinned_by_user");
  });
  it("recropping an anchor never swaps in a later node revision", async () => {
    mocks.map.mockResolvedValue({ _id: "world", entities: [{ ...place, identity_anchor: { node_id: "node", image_key: "original.png", bbox } }], updated_at: new Date(version) });
    const next = await updatePlace("world", "tower", { expected_updated_at: version, reference: { node_id: "node", bbox: { ...bbox, w_pct: .5 } } });
    expect(next.identity_anchor?.image_key).toBe("original.png");
    expect(mocks.bytes).toHaveBeenCalledWith("original.png");
  });
  it.each([null, { contentType: "text/plain", bytes: Buffer.from("bad") }])("rejects missing/nonimage reference %#", async stored => {
    mocks.bytes.mockResolvedValue(stored);
    await expect(updatePlace("world", "tower", { expected_updated_at: version, reference: { node_id: "node", bbox } })).rejects.toMatchObject({ status: 422 });
    expect(mocks.mapWrite).not.toHaveBeenCalled();
  });
  it("propagates a linked-write failure to abort the transaction", async () => {
    mocks.entityWrite.mockRejectedValue(new Error("write failed"));
    await expect(updatePlace("world", "tower", { expected_updated_at: version, label: "x" })).rejects.toThrow("write failed");
  });
});
