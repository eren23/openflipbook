import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const recent = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/db", () => ({ listRecentErrors: recent, getDb: async () => ({ command: async () => ({}), collection: () => ({ countDocuments: async () => 1 }) }) }));
vi.mock("@/lib/r2", () => ({ storedBucketReachable: async () => true }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
import StatusPage from "@/app/status/page";

beforeEach(() => {
  recent.mockClear();
  vi.stubEnv("MODAL_API_URL", "http://backend:8000/");
  vi.stubEnv("MONGODB_URI", "mongodb://mongo:27017");
  vi.stubEnv("MONGODB_DB", "test");
  vi.stubEnv("R2_ACCOUNT_ID", "");
  vi.stubEnv("R2_ENDPOINT", "http://minio:9000");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("R2_BUCKET", "test-bucket");
  vi.stubEnv("R2_PUBLIC_BASE_URL", "http://localhost:9000/test-bucket");
  vi.stubEnv("SHARED_TOKEN", "test-token");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, uptime_s: 2, providers: { fal: true, openrouter: true } })));
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("authenticates the bounded backend status probe and recognizes an S3 endpoint without a Cloudflare account", async () => {
  const ui = render(await StatusPage());
  expect(fetch).toHaveBeenCalledWith("http://backend:8000/status", expect.objectContaining({ cache: "no-store", headers: { "x-openflipbook-token": "test-token" }, signal: expect.any(AbortSignal) }));
  expect(screen.getByText(/All required env vars are set/)).toBeTruthy();
  expect(screen.getByText("R2_ENDPOINT or R2_ACCOUNT_ID + bucket + keys").closest("li")!.textContent).toContain("set");
  expect(ui.container.textContent).not.toMatch(/test-secret|test-access|test-token/);
});

it("reports missing storage configuration and a denied backend probe accurately", async () => {
  vi.stubEnv("R2_ENDPOINT", "");
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
  render(await StatusPage());
  expect(screen.getByText(/Some required env vars are missing/)).toBeTruthy();
  expect(screen.getByText(/Backend unreachable: HTTP 401/)).toBeTruthy();
});

it("keeps global error details operator-only on deployed status pages", async () => {
  vi.stubEnv("NODE_ENV", "production");
  render(await StatusPage());
  expect(screen.getByText(/Operator debug access is required/)).toBeTruthy();
  expect(recent).not.toHaveBeenCalled();
  expect(screen.getByText("MongoDB: reachable")).toBeTruthy();
  expect(screen.getByText("Private bucket: reachable")).toBeTruthy();
  expect(screen.getByText("Worker heartbeat: fresh")).toBeTruthy();
});
