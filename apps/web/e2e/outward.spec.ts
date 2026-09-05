import { type Locator, expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

test.skip(!process.env.E2E_MOCK, "mock-only: exercises OUTWARD without paid model calls");

async function expectSeparate(a: Locator, b: Locator) {
  const first = await a.boundingBox();
  const second = await b.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  const overlaps = first!.x < second!.x + second!.width && second!.x < first!.x + first!.width &&
    first!.y < second!.y + second!.height && second!.y < first!.y + first!.height;
  expect(overlaps, "image controls must not overlap").toBe(false);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`OUTWARD preserves the saved source and returns to it on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let sessionId = "";
    let generations = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/generate-page") && req.method() === "POST") {
        sessionId = req.postDataJSON().session_id;
        generations += 1;
      }
    });
    const persist = page.waitForResponse((r) => r.url().endsWith("/api/nodes") && r.request().method() === "POST");
    await page.goto("/play?q=" + encodeURIComponent("a walled river city"));
    const rootResponse = await persist;
    expect(rootResponse.ok()).toBe(true);
    const root = await rootResponse.json() as { id: string };
    const source = await waitForStableImage(page);
    const originalNode = await (await page.request.get(`/api/nodes/${root.id}`)).json();

    const save = page.waitForResponse((r) => r.url().endsWith(`/api/world/${sessionId}/ascend`) && r.request().method() === "POST");
    await page.getByTitle("Zoom out to the place that contains this one (OUTWARD)").click();
    const saveResponse = await save;
    expect(saveResponse.ok()).toBe(true);
    const parent = await saveResponse.json() as { parent_node_id: string };
    await expect(page).toHaveURL(new RegExp(`/n/${parent.parent_node_id}`));
    await waitForStableImage(page);
    expect(generations).toBe(2);

    const savedSource = await (await page.request.get(`/api/nodes/${root.id}`)).json();
    expect(savedSource.parent_id).toBe(parent.parent_node_id);
    expect(savedSource.image_url).toBe(originalNode.image_url);
    await expect(page.getByRole("button", { name: /back$/, exact: false }).first()).toBeEnabled();
    if (viewport.name === "mobile") {
      await expect(page.locator("figcaption")).toBeHidden();
    } else {
      await expectSeparate(page.getByRole("button", { name: "Pin style", exact: true }), page.locator("figcaption > span"));
    }
    await expectSeparate(page.getByRole("button", { name: /World Mode is on/ }), page.getByRole("button", { name: "Wander", exact: true }));
    const outwardScreenshot = testInfo.outputPath(`${viewport.name}-outward.png`);
    await page.screenshot({ path: outwardScreenshot, fullPage: true });
    await testInfo.attach(`${viewport.name}-outward`, { path: outwardScreenshot, contentType: "image/png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByTitle("Go back (←)").click();
    await expect(page).toHaveURL(new RegExp(`/n/${root.id}`));
    expect(await waitForStableImage(page)).toBe(source);
    expect(generations).toBe(2);
    const returnedScreenshot = testInfo.outputPath(`${viewport.name}-returned.png`);
    await page.screenshot({ path: returnedScreenshot, fullPage: true });
    await testInfo.attach(`${viewport.name}-returned`, { path: returnedScreenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  });
}

test("a rejected OUTWARD result leaves the source visible and does not save a parent", async ({ page }) => {
  const persist = page.waitForResponse((r) => r.url().endsWith("/api/nodes") && r.request().method() === "POST");
  await page.goto("/play?q=" + encodeURIComponent("a small river city"));
  await persist;
  const source = await waitForStableImage(page);
  const sourceUrl = page.url();
  let saves = 0;
  page.on("request", (req) => { if (req.url().endsWith("/ascend")) saves += 1; });
  await page.route("**/api/generate-page", async (route) => {
    if (route.request().postDataJSON().mode !== "ascend") return route.continue();
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"error","message":"The wider view did not pass the quality checks. Your world is unchanged."}\n\n',
    });
  });
  const outward = page.getByTitle("Zoom out to the place that contains this one (OUTWARD)");
  await outward.click();
  await expect(page.getByTitle("The wider view did not pass the quality checks. Your world is unchanged.")).toBeVisible();
  await expect(outward).toBeEnabled();
  expect(await waitForStableImage(page)).toBe(source);
  expect(page.url()).toBe(sourceUrl);
  expect(saves).toBe(0);
});
