import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Places from "@/lib/places";
const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), updatePlace: vi.fn(), getWorldMap: vi.fn(), getStoredBytes: vi.fn() }));
vi.mock("@/lib/session-owner", () => mocks);
vi.mock("@/lib/places", async original => ({ ...await original<typeof Places>(), updatePlace: mocks.updatePlace }));
vi.mock("@/lib/world-map", () => mocks);
vi.mock("@/lib/r2", () => mocks);
import { PATCH, GET } from "@/app/api/world/[sessionId]/places/[geoId]/route";
import { PlaceError } from "@/lib/places";
const params = { params: Promise.resolve({ sessionId: "world", geoId: "tower" }) };
const patch = { expected_updated_at: "2026-09-06T00:00:00.000Z", label: "Beacon" };
const request = (body: unknown = patch) => new Request("http://localhost/api/world/world/places/tower", { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOwner.mockResolvedValue({ ok: true });
  mocks.updatePlace.mockResolvedValue({ id: "tower", label: "Beacon" });
  mocks.getWorldMap.mockResolvedValue({ entities: [{ id: "tower", identity_anchor: { image_key: "original.png" } }] });
  mocks.getStoredBytes.mockResolvedValue({ bytes: Buffer.from("original"), contentType: "image/png" });
});
describe("place routes", () => {
  it("checks ownership before any mutation", async () => {
    mocks.requireOwner.mockResolvedValue({ ok: false, res: new Response(null, { status: 403 }) });
    expect((await PATCH(request(), params)).status).toBe(403);
    expect(mocks.updatePlace).not.toHaveBeenCalled();
  });
  it.each([null, [], { ...patch, reference: { image_key: "foreign.png" } }])("rejects malformed updates %j", async body => {
    expect((await PATCH(request(body), params)).status).toBe(400);
    expect(mocks.updatePlace).not.toHaveBeenCalled();
  });
  it("returns the saved place and propagates stale conflicts", async () => {
    expect((await PATCH(request(), params)).status).toBe(200);
    mocks.updatePlace.mockRejectedValue(new PlaceError("changed", 409));
    expect((await PATCH(request(), params)).status).toBe(409);
    mocks.updatePlace.mockRejectedValue(new Error("private database detail"));
    const res = await PATCH(request(), params);
    expect(res.status).toBe(503); expect(await res.text()).not.toContain("private database");
  });
  it("serves only the persisted reference, ignoring untrusted key parameters", async () => {
    const res = await GET(new Request("http://localhost/?image_key=foreign.png"), params);
    expect(await res.text()).toBe("original");
    expect(mocks.getStoredBytes).toHaveBeenCalledWith("original.png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("handles missing and failed reference reads", async () => {
    mocks.getStoredBytes.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(404);
    mocks.getStoredBytes.mockRejectedValue(new Error("storage"));
    expect((await GET(request(), params)).status).toBe(503);
  });
});
