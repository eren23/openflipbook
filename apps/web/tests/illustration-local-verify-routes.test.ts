// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ quoteLocalIllustrationVerification: vi.fn(), verifyLocalIllustration: vi.fn() }));
vi.mock("@/lib/illustration-local-verify", () => ({ ...mocks, LOCAL_VERIFICATION_BODY_LIMIT: 16 * 1024 }));
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/views/[viewId]/illustrations/local-verify/route";
const params = { params: Promise.resolve({ sessionId: "world", viewId: "saved-camera" }) };
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/world/world/views/saved-camera/illustrations/local-verify", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
beforeEach(() => { vi.resetAllMocks(); mocks.quoteLocalIllustrationVerification.mockResolvedValue({ quote: { reservation: .01 } }); mocks.verifyLocalIllustration.mockResolvedValue({ verification: { status: "ready" }, accepted: false }); });
it("returns an owner-scoped private read-only quote with exact view/source parameters", async () => {
  const response = await GET(new Request("http://localhost/api/world/world/views/saved-camera/illustrations/local-verify?asset_id=local&asset_sha256=sha"), params);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  expect(mocks.quoteLocalIllustrationVerification).toHaveBeenCalledWith("world", "saved-camera", "local", "sha"); expect(mocks.verifyLocalIllustration).not.toHaveBeenCalled();
});
it("passes only the opt-in profile selector through the read-only quote route", async () => {
  const response = await GET(new Request("http://localhost/api/world/world/views/saved-camera/illustrations/local-verify?asset_id=local&asset_sha256=sha&segmentation_profile=sam3-visual-full-frame-v1"), params);
  expect(response.status).toBe(200); expect(mocks.quoteLocalIllustrationVerification).toHaveBeenCalledWith("world", "saved-camera", "local", "sha", "sam3-visual-full-frame-v1"); expect(mocks.verifyLocalIllustration).not.toHaveBeenCalled();
});
it("accepts only JSON writes from the current origin and binds the actual viewId parameter", async () => {
  expect((await POST(request('{"id":"request"}'), params)).status).toBe(200); expect(mocks.verifyLocalIllustration).toHaveBeenCalledWith("world", "saved-camera", { id: "request" });
  mocks.verifyLocalIllustration.mockClear();
  expect((await POST(request("{}", { origin: "https://foreign.test" }), params)).status).toBe(403); expect((await POST(request("{}", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  expect(mocks.verifyLocalIllustration).not.toHaveBeenCalled();
});
it("bounds request bytes and rejects malformed envelopes before the verification helper", async () => {
  for (const body of ["{", "null", "[]", "true"]) expect((await POST(request(body), params)).status).toBe(400);
  expect((await POST(request(JSON.stringify({ oversized: "x".repeat(16 * 1024) })), params)).status).toBe(413); expect(mocks.verifyLocalIllustration).not.toHaveBeenCalled();
});
it("preserves owner/stale/spend statuses and hides backend infrastructure details", async () => {
  for (const status of [403, 404, 409, 429]) { mocks.verifyLocalIllustration.mockRejectedValue(new CreatorError("Verification unavailable", status)); expect((await POST(request("{}"), params)).status).toBe(status); }
  mocks.verifyLocalIllustration.mockRejectedValue(new Error("Private backend token")); const response = await POST(request("{}"), params); expect(response.status).toBe(503); expect(await response.text()).not.toContain("token"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
