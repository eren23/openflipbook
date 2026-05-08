import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

test("deeplink ?q= renders the first page end-to-end", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("how does a steam engine work"));

  // The SSE pipeline progresses through `status` → optional `progress` → `final`.
  // We don't peek at SSE directly; we wait for the rendered <img> to settle.
  const finalSrc = await waitForStableImage(page);
  expect(finalSrc).toMatch(/^(data:image|https?:|\/)/);

  // The page title is baked INTO the image (text-as-pixels is the whole
  // point), so the alt attribute is the only DOM-side title check.
  const img = page.locator('img[alt^="Generated illustration"]');
  await expect(img).toHaveAttribute("alt", /Generated illustration for /);
});
