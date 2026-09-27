// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const { fork, identity } = vi.hoisted(() => ({ fork: vi.fn(), identity: vi.fn() }));
vi.mock("@/lib/fork", () => ({ forkSession: fork }));
vi.mock("@/lib/session-owner", () => ({ getOrCreateOwnerToken: identity }));
vi.mock("@/lib/env", () => ({ readServerEnv: () => ({ MONGODB_URI: "configured", MONGODB_DB: "test" }) }));
import { POST } from "@/app/api/sessions/[id]/fork/route";
import { CreatorError } from "@/lib/creator-error";
beforeEach(() => { vi.clearAllMocks(); fork.mockResolvedValue({ session_id: "copy", nodes: 10 }); identity.mockResolvedValue("token"); });
const request = (body = { node_id: "source", request_id: "retry" }, origin = "http://localhost") => new Request("http://localhost/api/sessions/original/fork", { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "original" }) };
it("establishes the credential before the atomically owned copy and forwards its retry identity", async () => {
  const response = await POST(request(), params);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(fork).toHaveBeenCalledWith("original", "source", "retry");
  expect(identity.mock.invocationCallOrder[0]).toBeLessThan(fork.mock.invocationCallOrder[0]!);
});
it("returns missing-source and permission errors without claiming a world separately", async () => {
  fork.mockResolvedValueOnce(null); expect((await POST(request(), params)).status).toBe(404);
  fork.mockRejectedValueOnce(new CreatorError("Private source", 403)); expect((await POST(request(), params)).status).toBe(403);
});
it("returns a retryable private error when the transaction fails", async () => {
  fork.mockRejectedValueOnce(new Error("Internal database details"));
  const response = await POST(request(), params); expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("Internal database details");
});
it("rejects cross-origin or malformed mutations before creating a credential", async () => {
  expect((await POST(request(undefined, "https://other.test"), params)).status).toBe(403);
  expect((await POST(new Request("http://localhost/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[" }), params)).status).toBe(400);
  expect(identity).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
});
it("retains the optional-body legacy endpoint without implicitly reusing a request", async () => {
  expect((await POST(new Request("http://localhost/fork", { method: "POST" }), params)).status).toBe(200);
  expect(fork).toHaveBeenCalledWith("original", null, undefined);
});
