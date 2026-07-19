import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// Around → the neighbour tray (#154 wire; mock neighbors route). Four tiles
// arrive from one bloom; clicking one navigates. The failed-count branch
// stays unit-tested (NeighbourTray.test.tsx) — forcing exactly-one-failure
// through the mock isn't worth the relay.
test("Around blooms four neighbours; clicking one navigates", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("a lively riverside town"));
  await waitForStableImage(page);

  await page.getByRole("button", { name: "Around", exact: true }).click();

  const tray = page.getByLabel("Neighbours around this page");
  await tray.waitFor({ state: "visible", timeout: 60_000 });
  const tiles = page.getByRole("button", { name: /^Explore / });
  await expect.poll(async () => tiles.count(), { timeout: 90_000 }).toBe(4);

  const beforeUrl = page.url();
  await tiles.first().click();
  await expect.poll(() => page.url(), { timeout: 60_000 }).not.toBe(beforeUrl);
  await waitForStableImage(page);
});
