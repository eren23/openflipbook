import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// The two reopen surfaces (by design, verified 2026-07-14): a hard /n/<id>
// load is the static share VIEWER; /play?continue=<session> is the
// interactive rehydration — and hydration must not generate anything.
test("share viewer renders; continue rehydrates without generating", async ({ page }) => {
  let sessionId = "";
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.session_id) sessionId = body.session_id;
    }
  });
  const persistPromise = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );

  await page.goto("/play?q=" + encodeURIComponent("a quiet mountain monastery"));
  await waitForStableImage(page);

  const persisted = (await (await persistPromise).json()) as { id?: string };
  expect(persisted.id).toBeTruthy();
  expect(sessionId).toBeTruthy();

  // 1) The share viewer: server-rendered from Mongo + Minio (both live in
  // the mock stack). Static on purpose — just prove the node renders.
  await page.goto(`/n/${persisted.id}`);
  await expect(page.locator("img").first()).toBeVisible({ timeout: 30_000 });

  // 2) The interactive reopen: hydration only — ZERO new generates.
  let generatesAfterContinue = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      generatesAfterContinue += 1;
    }
  });
  await page.goto(`/play?continue=${encodeURIComponent(sessionId)}`);
  await expect(
    page.locator('img[alt^="Generated illustration"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000); // settle window: any stray generate would fire here
  expect(generatesAfterContinue).toBe(0);
});
