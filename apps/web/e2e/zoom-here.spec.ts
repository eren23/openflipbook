import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// The optical zoom lives on right-click (#162/#169): taps enter, "closer
// without entering" is an explicit menu action that pins render_mode. The
// pinned mode rides the request body — that's the whole contract.
test("right-click → Zoom in here pins an optical-zoom render_mode", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("a walled coastal city"));
  await waitForStableImage(page);

  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5, {
    button: "right",
  });

  const item = page.getByText("Zoom in here", { exact: false }).first();
  await item.waitFor({ state: "visible", timeout: 10_000 });

  const reqPromise = page.waitForRequest(
    (req) =>
      req.url().includes("/api/generate-page") &&
      req.method() === "POST" &&
      (req.postData() ?? "").includes('"mode":"tap"'),
    { timeout: 60_000 },
  );

  await item.click();

  const body = JSON.parse((await reqPromise).postData() ?? "{}");
  // Root world map → submap cut; entered pages → closeup. Either is a valid
  // optical zoom; what matters is the EXPLICIT pin reached the wire.
  expect(["place_submap", "place_closeup"]).toContain(body.render_mode);
});
