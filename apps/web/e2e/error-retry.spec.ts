import { expect, test } from "@playwright/test";

// Friendly error banner + ↻ retry (#153). MOCK_ERROR in the query makes the
// mock LLM raise inside the REAL pipeline, so the SSE error frame, the banner,
// and the retry's fresh Idempotency-Key are all product code under test.
// Mock-only: real providers don't fail on demand.
test.skip(!process.env.E2E_MOCK, "mock-only: needs the MOCK_ERROR lever");

test("forced failure shows the banner; retry sends a FRESH idempotency key", async ({
  page,
}) => {
  const keys: string[] = [];
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/generate-page") && r.request().method() === "POST") {
      keys.push(r.request().headers()["idempotency-key"] ?? "");
      statuses.push(r.status());
    }
  });

  await page.goto("/play?q=" + encodeURIComponent("MOCK_ERROR any town"));

  const retry = page.getByRole("button", { name: /Try again/ });
  await retry.waitFor({ state: "visible", timeout: 60_000 });

  await retry.click();
  // The retry fails again (the token is still in the body) — the assertions
  // are about the RETRY MECHANICS, not recovery: a second request went out,
  // with a DIFFERENT key, and streamed (200) instead of being refused (409).
  await expect
    .poll(() => keys.length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBeTruthy();
  expect(keys[1]).not.toBe(keys[0]);
  expect(statuses[1]).toBe(200);
});
