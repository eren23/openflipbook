// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ motionStudyLibrary: vi.fn(), saveMotionStudy: vi.fn(), motionStudyFrame: vi.fn(), requireCreator: vi.fn() }));
vi.mock("@/lib/motion-study-server", () => mocks);
vi.mock("@/lib/creator", async original => ({ ...(await original<object>()), requireCreator: mocks.requireCreator }));
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/views/[viewId]/motion/studies/route";
import { GET as PNG } from "@/app/api/world/[sessionId]/motion-studies/[studyId]/[frame]/[pass]/route";
const params = { params: Promise.resolve({ sessionId: "world", viewId: "view" }) };
const pngParams = { params: Promise.resolve({ sessionId: "world", studyId: "study", frame: "0", pass: "render" }) };
const req = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/world/world/views/view/motion/studies", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => { vi.resetAllMocks(); mocks.requireCreator.mockResolvedValue({}); mocks.motionStudyLibrary.mockResolvedValue({ studies: [] }); mocks.motionStudyFrame.mockResolvedValue(new Uint8Array([1, 2, 3])); });
it("keeps saved metadata and frame responses private and non-cacheable", async () => {
  for (const response of [await GET(new Request("http://localhost"), params), await PNG(new Request("http://localhost"), pngParams)]) {
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  }
});
it("rejects foreign origins, non-JSON and malformed study bodies before saving", async () => {
  expect((await POST(req("{}", { origin: "https://elsewhere.test" }), params)).status).toBe(403);
  expect((await POST(req("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  for (const body of ["null", "[]", "{", "true"]) expect((await POST(req(body), params)).status).toBe(400);
  expect(mocks.saveMotionStudy).not.toHaveBeenCalled();
});
it("rejects ambiguous frame indices and hides storage failures", async () => {
  for (const frame of ["", "-1", "1.5", "01", "1e1"]) expect((await PNG(new Request("http://localhost"), { params: Promise.resolve({ sessionId: "world", studyId: "study", frame, pass: "render" }) })).status).toBe(400);
  expect(mocks.motionStudyFrame).not.toHaveBeenCalled();
  mocks.motionStudyFrame.mockRejectedValue(new Error("private key"));
  const response = await PNG(new Request("http://localhost"), pngParams);
  expect(response.status).toBe(503); expect(await response.text()).toBe("");
});
it("checks ownership before buffering and bounds an authenticated streamed upload", async () => {
  const request = req("{}"), reader = vi.spyOn(request.body!, "getReader");
  mocks.requireCreator.mockRejectedValueOnce(new CreatorError("Not owner", 403));
  expect((await POST(request, params)).status).toBe(403); expect(reader).not.toHaveBeenCalled();
  const chunk = new Uint8Array(65536), cancelled = vi.fn(); let count = 0;
  const body = new ReadableStream({ pull(controller) { if (count++ < 2000) controller.enqueue(chunk); else controller.close(); }, cancel: cancelled });
  const oversized = new Request("http://localhost/api/world/world/views/view/motion/studies", { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit & { duplex: "half" });
  expect((await POST(oversized, params)).status).toBe(413);
  expect(cancelled).toHaveBeenCalled(); expect(mocks.saveMotionStudy).not.toHaveBeenCalled();
});
