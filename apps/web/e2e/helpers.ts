import { type Page, expect } from "@playwright/test";

/**
 * Wait until the rendered illustration's `src` has been stable for `stableMs`.
 * The progressive-draft pipeline updates `src` mid-stream (draft → final), so
 * we can't assert on a single mount — we wait for the final stable frame.
 */
export async function waitForStableImage(
  page: Page,
  { timeoutMs = 180_000, stableMs = 2000 }: { timeoutMs?: number; stableMs?: number } = {},
): Promise<string> {
  const img = page.locator('img[alt^="Generated illustration"]');
  await img.waitFor({ state: "visible", timeout: timeoutMs });
  let last = "";
  let stableSince = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const src = (await img.getAttribute("src")) ?? "";
    if (src && src === last) {
      if (Date.now() - stableSince >= stableMs) return src;
    } else {
      last = src;
      stableSince = Date.now();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`image src never stabilised within ${timeoutMs}ms`);
}

export async function clickAtImageFraction(
  page: Page,
  xFrac: number,
  yFrac: number,
): Promise<void> {
  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  expect(box, "image must have a bounding box before clicking").not.toBeNull();
  await page.mouse.click(box!.x + box!.width * xFrac, box!.y + box!.height * yFrac);
}
