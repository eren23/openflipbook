import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// Phase-1 export affordances: the right-click menu can download the RAW render
// (distinct from Save-as-postcard, which frames it) and copy it to the
// clipboard. /api/image streams the stored bytes, with ?download=1 forcing an
// attachment so a cross-origin R2 blob still saves.
test("right-click → Download image streams the raw render as an attachment", async ({
  page,
}) => {
  await page.goto("/play?q=" + encodeURIComponent("a walled coastal city"));
  await waitForStableImage(page);

  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5, {
    button: "right",
  });

  // Both image-export items render in the page-level section and are enabled
  // (a persisted node → an image exists to export).
  await expect(page.getByText("Copy image", { exact: true })).toBeVisible();
  const download = page.getByText("Download image", { exact: true });
  await expect(download).toBeVisible();

  const reqP = page.waitForRequest(
    (r) => r.url().includes("/api/image/") && r.url().includes("download=1"),
    { timeout: 30_000 },
  );
  await download.click();
  const url = (await reqP).url();

  // Verify the route itself returns real bytes with the attachment disposition
  // (independent of the popup the click opens — assert the output, not the tab).
  const resp = await page.request.get(url);
  expect(resp.status()).toBe(200);
  expect(resp.headers()["content-disposition"] ?? "").toContain("attachment");
  expect((await resp.body()).length).toBeGreaterThan(0);
});
