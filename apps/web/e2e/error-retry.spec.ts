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

test("a failure that lands while HIDDEN auto-retries on return — no banner click needed", async ({
  page,
}) => {
  // The freeze-suspension class (live-caught): Chromium suspends background
  // tabs' fetches, killing in-flight generations; the backend cancels on
  // disconnect. The client remembers hidden-time errors and fires the
  // banner's own retry automatically when the tab returns.
  let posts = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      posts += 1;
    }
  });

  // The override must exist before the app's FIRST script: the mock error
  // frame lands well under a second after hydration, so a post-goto evaluate
  // loses the race and the error records as visible (caught live: the first
  // version of this test did exactly that).
  await page.addInitScript(() => {
    let vis = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => vis,
    });
    (window as unknown as { __setVis: (v: string) => void }).__setVis = (v) => {
      vis = v;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await page.goto("/play?q=" + encodeURIComponent("MOCK_ERROR hidden town"));

  await page
    .getByRole("button", { name: /Try again/ })
    .waitFor({ state: "visible", timeout: 60_000 });
  expect(posts).toBe(1);

  // The user comes back — the retry must fire on its own.
  await page.evaluate(() =>
    (window as unknown as { __setVis: (v: string) => void }).__setVis("visible"),
  );
  await expect.poll(() => posts, { timeout: 20_000 }).toBe(2);
});
