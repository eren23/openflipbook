import { expect, test } from "@playwright/test";

import { clickAtImageFraction, waitForStableImage } from "./helpers";

test("tap on rendered image generates a next page", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("how does a steam engine work"));
  await waitForStableImage(page);

  // Asserting via the network is more robust than diffing the <img> src —
  // during the morph animation two <img alt^="Generated…"> elements are
  // rendered (outgoing + incoming) and the annotated-click PNG can briefly
  // win the locator race.
  const reqPromise = page.waitForRequest(
    (req) =>
      req.url().includes("/api/generate-page") &&
      req.method() === "POST" &&
      (req.postData() ?? "").includes('"mode":"tap"'),
    { timeout: 60_000 },
  );

  await clickAtImageFraction(page, 0.5, 0.55);

  const req = await reqPromise;
  const body = JSON.parse(req.postData() ?? "{}");
  expect(body.mode).toBe("tap");
  expect(body.click).toBeTruthy();
  expect(typeof body.click.x_pct).toBe("number");
  expect(typeof body.click.y_pct).toBe("number");
});
