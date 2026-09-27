// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ illustrationLibrary: vi.fn(), illustrationAction: vi.fn(), meshBytes: vi.fn() }));
vi.mock("@/lib/illustration-server", () => mocks);
vi.mock("@/lib/mesh-server", () => mocks);
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/views/[viewId]/illustrations/route";
import { GET as JPEG } from "@/app/api/world/[sessionId]/illustrations/[assetId]/route";
const params = { params: Promise.resolve({ sessionId: "world", viewId: "view" }) };
const assetParams = { params: Promise.resolve({ sessionId: "world", assetId: "illustration_one" }) };
const req = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/world/world/views/view/illustrations", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => { vi.resetAllMocks(); mocks.illustrationLibrary.mockResolvedValue({ jobs: [], assets: [] }); mocks.illustrationAction.mockResolvedValue({}); mocks.meshBytes.mockResolvedValue(Buffer.from([1, 2, 3])); });
it("serves lossless region composites as private PNGs", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); mocks.meshBytes.mockResolvedValue(png);
  const response = await JPEG(new Request("http://localhost"), assetParams);
  expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
});
it("keeps library and JPEG bytes owner-scoped, private and non-cacheable", async () => {
  const list = await GET(new Request("http://localhost"), params), image = await JPEG(new Request("http://localhost"), assetParams);
  for (const response of [list, image]) { expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie"); }
  expect(mocks.illustrationLibrary).toHaveBeenCalledWith("world", "view");
  expect(mocks.meshBytes).toHaveBeenCalledWith("world", "illustration_one", "illustration");
  expect(image.headers.get("content-type")).toBe("image/jpeg"); expect(image.headers.get("x-content-type-options")).toBe("nosniff");
});
it("rejects foreign origins, wrong types, invalid JSON and oversized streamed bodies", async () => {
  expect((await POST(req("{}", { origin: "https://foreign.test" }), params)).status).toBe(403);
  expect((await POST(req("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  for (const body of ["{", "null", "[]", "false"]) expect((await POST(req(body), params)).status).toBe(400);
  expect((await POST(req(JSON.stringify({ prompt: "x".repeat(16_384) })), params)).status).toBe(413);
  expect(mocks.illustrationAction).not.toHaveBeenCalled();
});
it("preserves authorization errors without exposing internal failures", async () => {
  mocks.meshBytes.mockRejectedValue(new CreatorError("Not owned", 403));
  expect((await JPEG(new Request("http://localhost"), assetParams)).status).toBe(403);
  mocks.illustrationAction.mockRejectedValue(new Error("Secret provider credentials"));
  const response = await POST(req('{"action":"generate"}'), params);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("Secret");
});
