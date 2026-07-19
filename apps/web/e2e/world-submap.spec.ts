import { expect, test } from "@playwright/test";

import { clickAtImageFraction, waitForStableImage } from "./helpers";

// Map zooms are REDRAWN, not crop-upscaled (#164/#173). "district" steers the
// mock classifier to enter_as submap, so the tap rides the real SUBMAP_REDRAW
// path and the final reports its honest op on the wire.
test("world tap on a district rides the map REDRAW", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("a market district"));
  await waitForStableImage(page);

  const respPromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/generate-page") &&
      r.request().method() === "POST" &&
      (r.request().postData() ?? "").includes('"mode":"tap"'),
    { timeout: 60_000 },
  );

  await clickAtImageFraction(page, 0.5, 0.5);

  const resp = await respPromise;
  expect(resp.status()).toBe(200);
  const stream = await resp.text();
  expect(stream).toContain('"image_op": "map_redraw"');
});
