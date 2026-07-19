import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// Wander's spend seatbelt (#155): exactly WANDER_MAX_PAGES auto-taps, then
// the stop pill and NOT ONE more. Only possible under mock at all since
// #176 fixed the candidates route (it was swallowed by the click catch-all
// and wander died instantly with "no-candidates"). ~60-90s wall: 8 cycles of
// 2.6s linger + a mock generation each — accepted; ?wanderLingerMs= is the
// flagged upgrade path if this ever dominates the suite.
test("wander explores exactly 8 pages then stops itself", async ({ page }) => {
  test.setTimeout(180_000);

  let tapCount = 0;
  page.on("request", (req) => {
    if (
      req.url().includes("/api/generate-page") &&
      req.method() === "POST" &&
      (req.postData() ?? "").includes('"mode":"tap"')
    ) {
      tapCount += 1;
    }
  });

  await page.goto("/play?q=" + encodeURIComponent("a sprawling old harbor town"));
  await waitForStableImage(page);

  await page.getByRole("button", { name: /Wander/ }).click();

  await page
    .getByText(/explored 8 pages/)
    .waitFor({ state: "visible", timeout: 150_000 });

  expect(tapCount).toBe(8);
  // The toggle flipped itself back off — no ninth tap is even armed.
  await expect(page.getByRole("button", { name: /Wander/ })).toBeVisible();
  await page.waitForTimeout(4000); // longer than a linger — a 9th tap would land here
  expect(tapCount).toBe(8);
});
