import { type Locator, expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  expect(b, "element must have a bounding box").not.toBeNull();
  return b!;
}

// Regression guard for the tap-hint hiding behind the bottom-corner buttons.
// The hint used to be a full-width left-aligned bar that "📌 Pin style" (and the
// geo "localize now" button) sat on top of. It is now a centered pill — assert
// it shares the row with those buttons but never overlaps them.
test("tap-hint pill stays clear of the bottom-corner buttons", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("a quiet harbour at dawn"));
  await waitForStableImage(page);

  const hint = page.getByText(/tap anywhere on the image to explore/i);
  const pin = page.getByRole("button", { name: /^Pin style$/ });

  await expect(hint).toBeVisible();
  await expect(pin).toBeVisible();

  const hintBox = await box(hint);
  const pinBox = await box(pin);

  expect(
    overlaps(hintBox, pinBox),
    "the tap-hint must not overlap the Pin-style button",
  ).toBe(false);
});
