// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ motionJobLibrary: vi.fn(), motionJobAction: vi.fn(), motionVideoBytes: vi.fn(), requireCreator: vi.fn() }));
vi.mock("@/lib/motion-job-server", () => mocks);
vi.mock("@/lib/creator", async original => ({ ...(await original<object>()), requireCreator: mocks.requireCreator }));
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/motion-studies/[studyId]/jobs/route";
import { GET as VIDEO } from "@/app/api/world/[sessionId]/motion-studies/[studyId]/videos/[assetId]/route";
const params = { params: Promise.resolve({ sessionId: "world", studyId: "study" }) };
const videoParams = { params: Promise.resolve({ sessionId: "world", studyId: "study", assetId: "clip" }) };
const url = "http://localhost/api/world/world/motion-studies/study/jobs";
const req = (body: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => {
  vi.resetAllMocks(); mocks.requireCreator.mockResolvedValue({}); mocks.motionJobLibrary.mockResolvedValue({ jobs: [], assets: [] });
  mocks.motionJobAction.mockResolvedValue({ saved: true }); mocks.motionVideoBytes.mockResolvedValue(Buffer.from("silent-video"));
});
it("keeps library and silent video private and read-only", async () => {
  const library = await GET(new Request(url), params), video = await VIDEO(new Request(url), videoParams);
  for (const response of [library, video]) {
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  }
  expect(video.headers.get("content-type")).toBe("video/mp4"); expect(video.headers.get("content-length")).toBe("12");
  expect(video.headers.get("x-content-type-options")).toBe("nosniff"); expect(await video.text()).toBe("silent-video");
  expect(mocks.motionVideoBytes).toHaveBeenCalledWith("world", "study", "clip"); expect(mocks.motionJobAction).not.toHaveBeenCalled();
});
it("rejects foreign origin, non-JSON and malformed actions without dispatching", async () => {
  expect((await POST(req("{}", { origin: "https://foreign.test" }), params)).status).toBe(403);
  expect((await POST(req("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  for (const body of ["null", "[]", "true", "{"]) expect((await POST(req(body), params)).status).toBe(400);
  expect(mocks.motionJobAction).not.toHaveBeenCalled();
});
it("authorizes before reading and cancels oversized streamed actions", async () => {
  const request = req("{}"), reader = vi.spyOn(request.body!, "getReader");
  mocks.requireCreator.mockRejectedValueOnce(new CreatorError("Not owner", 403));
  expect((await POST(request, params)).status).toBe(403); expect(reader).not.toHaveBeenCalled();
  const cancel = vi.fn(), body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel });
  const oversized = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit & { duplex: "half" });
  expect((await POST(oversized, params)).status).toBe(413); expect(cancel).toHaveBeenCalled(); expect(mocks.motionJobAction).not.toHaveBeenCalled();
});
it("dispatches the exact owner action and sanitizes unexpected errors", async () => {
  const action = { action: "cancel", id: "shot" };
  expect((await POST(req(JSON.stringify(action)), params)).status).toBe(200);
  expect(mocks.motionJobAction).toHaveBeenCalledWith("world", "study", action);
  mocks.motionJobAction.mockRejectedValue(new Error("private provider credential"));
  const response = await POST(req(JSON.stringify(action)), params);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("credential");
});
it.each([403, 404, 503])("returns a private empty video error for status %i", async status => {
  mocks.motionVideoBytes.mockRejectedValue(status === 503 ? new Error("private storage key") : new CreatorError("Not available", status));
  const response = await VIDEO(new Request(url), videoParams);
  expect(response.status).toBe(status); expect(await response.text()).toBe(""); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("authenticates ranged replay before exposing any bytes or file size", async () => {
  const request = new Request(url, { headers: { range: "bytes=0-1" } });
  mocks.motionVideoBytes.mockRejectedValueOnce(new CreatorError("Not owner", 403));
  const denied = await VIDEO(request, videoParams); expect(denied.status).toBe(403); expect(denied.headers.has("content-range")).toBe(false);
  const response = await VIDEO(request, videoParams); expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 0-1/12"); expect(await response.text()).toBe("si");
});
