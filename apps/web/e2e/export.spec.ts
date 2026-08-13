import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// Phase-1 export affordances: the right-click menu can download the RAW render
// (distinct from Save-as-postcard, which frames it) and copy it. /api/image
// streams the stored bytes; ?download=1 forces an attachment so a cross-origin
// R2 blob still saves, bare bytes feed the same-origin copy→clipboard path.
test("right-click exposes image export; /api/image serves attachment + inline", async ({
  page,
}) => {
  // The node id that enables the export actions lands only when the page is
  // persisted (POST /api/nodes → the detached .then sets page.nodeId). Wait for
  // that, not just the stable image, or the menu items stay disabled.
  const persistPromise = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );
  await page.goto("/play?q=" + encodeURIComponent("a walled coastal city"));
  await waitForStableImage(page);
  const persisted = (await (await persistPromise).json()) as { id?: string };
  expect(persisted.id).toBeTruthy();

  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5, {
    button: "right",
  });

  // Wiring + gating: both items render and are enabled once a node is persisted
  // (same gate as Save-as-postcard).
  await expect(page.getByText("Copy image", { exact: true })).toBeEnabled();
  await expect(page.getByText("Download image", { exact: true })).toBeEnabled();

  // The route both items hit — attachment mode (Download) and inline bytes
  // (the Copy path fetches these same-origin to re-encode for the clipboard).
  const dl = await page.request.get(`/api/image/${persisted.id}?download=1`);
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-disposition"] ?? "").toContain("attachment");
  expect((await dl.body()).length).toBeGreaterThan(0);

  const inline = await page.request.get(`/api/image/${persisted.id}`);
  expect(inline.status()).toBe(200);
  expect(inline.headers()["content-disposition"] ?? "").toBeFalsy();
  expect(inline.headers()["content-type"] ?? "").toContain("image/");
});
