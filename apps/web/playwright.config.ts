import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
// E2E_MOCK=1: the suite runs against the MOCK_PROVIDERS stack (the every-PR
// CI gate). Generations return in seconds, so a hang should fail in minutes,
// not the quarter-hour a real-model run legitimately needs.
const MOCK = !!process.env.E2E_MOCK;

export default defineConfig({
  testDir: "./e2e",
  // Real models: VLM click-resolve (40s) + planner (30s) + image gen (30s)
  // eats most of a tap-to-final cycle; a click-to-next test runs that twice.
  // Mock: everything is deterministic and near-instant — tight timeouts so
  // a real hang surfaces fast.
  timeout: MOCK ? 120_000 : 240_000,
  expect: { timeout: MOCK ? 30_000 : 60_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
