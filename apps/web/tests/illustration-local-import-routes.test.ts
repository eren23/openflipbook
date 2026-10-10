// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ importLocalIllustration: vi.fn() }));
vi.mock("@/lib/illustration-local-import", () => ({ ...mocks, LOCAL_IMPORT_BODY_LIMIT: 12 * 1024 * 1024 }));
import { CreatorError } from "@/lib/creator";
import { POST } from "@/app/api/world/[sessionId]/views/[viewId]/illustrations/import/route";
const params = { params: Promise.resolve({ sessionId: "world", viewId: "saved-camera" }) };
const req = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/world/world/views/saved-camera/illustrations/import", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => { vi.resetAllMocks(); mocks.importLocalIllustration.mockResolvedValue({ id: "local_draft", gate: "unmeasured", accepted: false }); });
it("keeps the owner draft response private and binds the exact saved view route parameter", async () => {
  const response = await POST(req('{"id":"request"}'), params);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  expect(await response.json()).toMatchObject({ gate: "unmeasured", accepted: false });
  expect(mocks.importLocalIllustration).toHaveBeenCalledWith("world", "saved-camera", { id: "request" });
});
it("rejects foreign origins, content types and malformed requests before the import helper", async () => {
  expect((await POST(req("{}", { origin: "https://elsewhere.test" }), params)).status).toBe(403);
  expect((await POST(req("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  for (const body of ["{", "null", "[]", "true"]) expect((await POST(req(body), params)).status).toBe(400);
  expect(mocks.importLocalIllustration).not.toHaveBeenCalled();
});
it("bounds the streamed upload before parsing or invoking owner storage", async () => {
  const response = await POST(req(JSON.stringify({ oversized: "x".repeat(12 * 1024 * 1024) })), params);
  expect(response.status).toBe(413); expect(mocks.importLocalIllustration).not.toHaveBeenCalled();
});
it("preserves ownership/rate/stale errors and hides infrastructure details", async () => {
  for (const status of [403, 404, 409, 429]) {
    mocks.importLocalIllustration.mockRejectedValue(new CreatorError("Import unavailable", status));
    expect((await POST(req("{}"), params)).status).toBe(status);
  }
  mocks.importLocalIllustration.mockRejectedValue(new Error("Private store credentials"));
  const response = await POST(req("{}"), params);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("credentials"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
