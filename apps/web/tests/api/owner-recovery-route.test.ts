// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ token: vi.fn(), redeem: vi.fn() }));
vi.mock("@/lib/session-owner", () => ({ getExistingOwnerToken: f.token }));
vi.mock("@/lib/owner-recovery", () => ({ redeemOwnerRecovery: f.redeem }));
import { CreatorError } from "@/lib/creator";
import { POST } from "@/app/api/creator/recovery/route";
const url = "http://localhost/api/creator/recovery", code = `ofbr1_${"a".repeat(32)}.${"b".repeat(64)}`;
const post = (body = JSON.stringify({ code }), headers = {}) => POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }));
beforeEach(() => { vi.resetAllMocks(); f.token.mockResolvedValue("recipient"); f.redeem.mockResolvedValue({ session_id: "world", recovered: true }); });
it("checks origin, content type and JSON shape before access recovery", async () => {
  expect((await post(undefined, { Origin: "https://foreign.test" })).status).toBe(403);
  expect((await post(undefined, { "Content-Type": "text/plain" })).status).toBe(415);
  for (const body of ["", "{", "null", "[]", '"code"', JSON.stringify({ code, world: "other" })]) expect((await post(body)).status).toBe(400);
  expect(f.token).not.toHaveBeenCalled(); expect(f.redeem).not.toHaveBeenCalled();
});
it("bounds declared and streamed bytes, including multibyte text, before recovery", async () => {
  expect((await post(undefined, { "Content-Length": "1025" })).status).toBe(413);
  expect((await post(JSON.stringify({ code: "\u00e9".repeat(600) }))).status).toBe(413);
  const cancel = vi.fn(); let chunks = 0;
  const body = new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(256)); }, cancel });
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit);
  expect((await POST(request)).status).toBe(413); expect(cancel).toHaveBeenCalled(); expect(chunks).toBeLessThanOrEqual(6);
  expect(f.redeem).not.toHaveBeenCalled();
});
it("uses only the existing cookie and returns private non-secret results", async () => {
  const response = await post(); expect(response.status).toBe(200);
  expect(f.redeem).toHaveBeenCalledWith(code, "recipient");
  expect(await response.json()).toEqual({ session_id: "world", recovered: true });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(response.headers.get("Vary")).toBe("Cookie");
  expect(response.headers.get("Set-Cookie")).toBeNull();
  f.token.mockResolvedValue(null); f.redeem.mockRejectedValueOnce(new CreatorError("Initialize this browser's workspace before recovering access", 409));
  expect((await post()).status).toBe(409); expect(f.redeem).toHaveBeenLastCalledWith(code, null);
});
it("does not expose code or database errors on failure", async () => {
  f.redeem.mockRejectedValueOnce(new Error(`connection failed ${code}`));
  const response = await post(); expect(response.status).toBe(503); expect(await response.text()).not.toContain(code);
  f.redeem.mockRejectedValueOnce(new CreatorError("Recovery code is invalid, expired or no longer active", 403));
  expect((await post()).status).toBe(403);
});
