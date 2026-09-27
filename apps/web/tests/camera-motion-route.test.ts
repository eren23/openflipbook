// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cameraMotionPreview: vi.fn() }));
vi.mock("@/lib/camera-motion-server", () => mocks);
import { CreatorError } from "@/lib/creator";
import * as route from "@/app/api/world/[sessionId]/views/[viewId]/motion/route";
const params = { params: Promise.resolve({ sessionId: "world", viewId: "view" }) };
beforeEach(() => vi.resetAllMocks());
it("returns private, non-cacheable preparation with no write handler", async () => {
  mocks.cameraMotionPreview.mockResolvedValue({ generation_enabled: false, status: "calibration_required" });
  const response = await route.GET(new Request("http://localhost/api/world/world/views/view/motion"), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(await response.json()).toEqual({ generation_enabled: false, status: "calibration_required" });
  expect(mocks.cameraMotionPreview).toHaveBeenCalledWith("world", "view");
  expect(route).not.toHaveProperty("POST");
});
it("preserves ownership and stale-source failures", async () => {
  for (const status of [400, 403, 404, 409]) {
    mocks.cameraMotionPreview.mockRejectedValue(new CreatorError("Unavailable", status));
    const response = await route.GET(new Request("http://localhost"), params);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});
it("does not expose infrastructure errors", async () => {
  mocks.cameraMotionPreview.mockRejectedValue(new Error("private storage credentials"));
  const response = await route.GET(new Request("http://localhost"), params);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("credentials");
});
