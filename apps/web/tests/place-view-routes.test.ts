// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ placeViewBytes: vi.fn(), placeViewLibrary: vi.fn(), savePlaceView: vi.fn() }));
vi.mock("@/lib/place-view-server", () => mocks);
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/places/[geoId]/views/route";
import { GET as PNG } from "@/app/api/world/[sessionId]/views/[viewId]/[pass]/route";
const params = { params: Promise.resolve({ sessionId: "world", geoId: "place" }) };
const pngParams = { params: Promise.resolve({ sessionId: "world", viewId: "view", pass: "depth" }) };
const req = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/world/world/places/place/views", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => { vi.resetAllMocks(); mocks.placeViewLibrary.mockResolvedValue({ views: [] }); mocks.savePlaceView.mockResolvedValue({ id: "view" }); mocks.placeViewBytes.mockResolvedValue(new Uint8Array([1, 2, 3])); });
it("keeps successful view lists and image bytes private and non-cacheable", async () => {
  const list = await GET(new Request("http://localhost"), params), image = await PNG(new Request("http://localhost"), pngParams);
  for (const r of [list, image]) { expect(r.headers.get("cache-control")).toBe("private, no-store"); expect(r.headers.get("vary")).toBe("Cookie"); }
  expect(image.headers.get("content-type")).toBe("image/png"); expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});
it("rejects foreign origin, wrong content type and invalid JSON before storage", async () => {
  expect((await POST(req("{}", { origin: "https://elsewhere.test" }), params)).status).toBe(403);
  expect((await POST(req("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  for (const body of ["{", "null", "[]", "true"]) expect((await POST(req(body), params)).status).toBe(400);
  expect(mocks.savePlaceView).not.toHaveBeenCalled();
});
it("bounds the streamed UTF-8 request body before parsing or storage", async () => {
  expect((await POST(req(JSON.stringify({ label: "x".repeat(20 * 1024 * 1024) })), params)).status).toBe(413);
  expect(mocks.savePlaceView).not.toHaveBeenCalled();
});
it("preserves known errors and hides infrastructure details on both routes", async () => {
  for (const status of [400, 403, 404, 409, 503]) {
    mocks.placeViewBytes.mockRejectedValue(new CreatorError("Private detail", status));
    const image = await PNG(new Request("http://localhost"), pngParams); expect(image.status).toBe(status); expect(await image.text()).toBe(""); expect(image.headers.get("cache-control")).toBe("private, no-store");
  }
  mocks.savePlaceView.mockRejectedValue(new Error("Secret storage key"));
  const response = await POST(req("{}"), params); expect(response.status).toBe(503); expect(await response.text()).not.toContain("Secret");
});
