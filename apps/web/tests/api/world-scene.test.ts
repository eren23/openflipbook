import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ read: vi.fn(), preview: vi.fn(), apply: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/place-scene-server", () => ({ readPlaceScene: api.read, previewPlaceScene: api.preview, applyPlaceScene: api.apply, sceneContext: api.context }));
import { GET, POST } from "@/app/api/world/[sessionId]/places/[geoId]/scene/route";
import { GET as contextGET } from "@/app/api/world/scene-context/route";
import { CreatorError } from "@/lib/creator";
const params = { params: Promise.resolve({ sessionId: "world", geoId: "garden" }) };
const request = (body: unknown, extra = {}) => ({ url: "http://localhost/api/world/world/places/garden/scene", headers: new Headers({ "Content-Type": "application/json", ...extra }), text: async () => JSON.stringify(body) }) as Request;
beforeEach(() => { vi.resetAllMocks(); api.read.mockResolvedValue({ scene: null }); api.preview.mockResolvedValue({ proposal: { id: "p" } }); api.apply.mockResolvedValue({ scene: { revision: 1 } }); });
it("uses private, uncached responses and relays permission failures", async () => {
  const r = await GET(new Request("http://localhost"), params); expect(r.headers.get("cache-control")).toBe("private, no-store");
  api.read.mockRejectedValue(new CreatorError("Not owner", 403)); expect((await GET(new Request("http://localhost"), params)).status).toBe(403);
});
it("dispatches preview/apply but rejects foreign origins and malformed payloads", async () => {
  expect((await POST(request({ action: "preview", definition: {} }), params)).status).toBe(200);
  expect((await POST(request({ action: "apply", proposal_id: "p" }), params)).status).toBe(200);
  expect(api.apply).toHaveBeenCalledWith("world", "garden", "p");
  expect((await POST(request({ action: "apply" }, { origin: "https://foreign.test" }), params)).status).toBe(403);
  expect((await POST(request({ action: "other" }), params)).status).toBe(400);
  expect((await POST(request(null), params)).status).toBe(400);
  expect((await POST(request({ huge: "x".repeat(150_001) }), params)).status).toBe(413);
  api.apply.mockRejectedValue(new CreatorError("Stale", 409)); expect((await POST(request({ action: "apply" }), params)).status).toBe(409);
});
it("resolves source and draft without exposing a database error", async () => {
  api.context.mockResolvedValue({ scene: null }); await contextGET(new Request("http://localhost?source=root&place=garden&draft=drawing"));
  expect(api.context).toHaveBeenCalledWith("root", "garden", "drawing");
  api.context.mockRejectedValue(new Error("private database details")); const res = await contextGET(new Request("http://localhost"));
  expect(res.status).toBe(503); expect(await res.text()).not.toContain("private database");
});
