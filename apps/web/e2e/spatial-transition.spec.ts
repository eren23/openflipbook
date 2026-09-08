import { expect, test } from "@playwright/test";
import { clickAtImageFraction, waitForStableImage } from "./helpers";

test.skip(process.env.E2E_SPATIAL !== "1" || process.env.E2E_MOCK !== "1", "Opt-in, zero-cost mock proof only");

test("spatial navigation holds the source, commits at the cut, and replays without video calls", async ({ page }) => {
  let animateCalls = 0;
  page.on("request", req => { if (/\/api\/(animate|ltx)/.test(req.url())) animateCalls++; });
  await page.goto("/play?q=" + encodeURIComponent("an old stone tower"));
  const source = await waitForStableImage(page);
  const oldUrl = page.url();
  let release!: () => void;
  let intercepted!: () => void;
  const requestSeen = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route("**/api/generate-page", async route => {
    if (route.request().postDataJSON().mode !== "tap") return route.continue();
    const response = await route.fetch();
    await new Promise<void>(resolve => { release = resolve; intercepted(); });
    await route.fulfill({ response });
  });
  const persisted = page.waitForResponse(r => /\/api\/nodes$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await clickAtImageFraction(page, .5, .5);
  await requestSeen;
  const image = page.locator('img[alt^="Generated illustration"]').first();
  await expect(image).toHaveAttribute("src", source);
  expect(page.url()).toBe(oldUrl);
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  release();
  const saved = await (await persisted).json();
  expect(saved.transition_context.source_image_key).toBeTruthy();
  expect(saved.transition_context.target_point.x_pct).toBeCloseTo(.5, 1);
  await expect(page.getByTestId("spatial-transition")).toBeVisible();
  await expect(image).toHaveAttribute("src", source);
  expect(page.url()).toBe(oldUrl);
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/n/${saved.id}`));
  const arrival = await image.getAttribute("src");
  await page.getByRole("button", { name: "Replay arrival", exact: true }).click();
  await expect(page.getByTestId("spatial-transition")).toBeVisible();
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  await expect(image).toHaveAttribute("src", arrival!);
  await page.getByTitle("Go back (←)").click();
  await expect(page.getByTestId("spatial-transition")).toHaveAttribute("data-direction", "back");
  await expect(page).toHaveURL(oldUrl);
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  await expect(image).toHaveAttribute("src", source);
  await page.getByTitle("Go forward (→)").click();
  await expect(page).toHaveURL(new RegExp(`/n/${saved.id}`));
  await page.reload();
  await page.getByRole("link", { name: "Continue this session", exact: true }).click();
  await waitForStableImage(page);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Replay arrival", exact: true }).click();
    await expect(page.getByTestId("spatial-content")).toBeVisible();
    const rects = await page.getByTestId("spatial-content").evaluate(el => {
      const clip = el.getBoundingClientRect();
      const img = el.querySelector("img")!;
      const pixels = img.getBoundingClientRect();
      return { covered: pixels.left <= clip.left + 1 && pixels.top <= clip.top + 1 && pixels.right >= clip.right - 1 && pixels.bottom >= clip.bottom - 1,
        ratio: clip.width / clip.height, native: img.naturalWidth / img.naturalHeight };
    });
    expect(rects.covered).toBe(true); expect(rects.ratio).toBeCloseTo(rects.native, 2);
    await page.screenshot({ path: `test-results/spatial-${viewport.width}.png` });
    await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("breadcrumb").getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(new URL(oldUrl).pathname));
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  expect(animateCalls).toBe(0);
});

test("an undecodable arrival retains the source and retries only the image", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("an old stone tower"));
  const source = await waitForStableImage(page);
  const sourceUrl = page.url();
  let generates = 0;
  await page.route("**/api/generate-page", async route => {
    generates++;
    const body = route.request().postDataJSON();
    const final = { type: "final", session_id: body.session_id, page_title: "Broken arrival",
      image_data_url: "data:image/jpeg;base64,YmFkLWltYWdl", image_model: "mock", prompt_author_model: "mock", final_prompt: "test fixture", sources: [] };
    await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(final)}\n\n` });
  });
  await clickAtImageFraction(page, .5, .5);
  const retry = page.getByRole("button", { name: "Retry transition image" });
  await expect(retry).toBeVisible();
  expect(page.url()).toBe(sourceUrl);
  await expect(page.locator('img[alt^="Generated illustration"]').first()).toHaveAttribute("src", source);
  await retry.click();
  await expect(retry).toBeVisible();
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  expect(generates).toBe(1);
  await page.getByRole("button", { name: "Dismiss transition error" }).click();
  await expect(retry).toHaveCount(0);
});
