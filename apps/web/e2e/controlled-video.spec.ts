import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_CONTROLLED !== "1", "Local saved-video study only; never submits generation");

test("controlled pilot plays and scrubs saved clips at desktop and mobile widths", async ({ page }) => {
  const paidRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    if (request.method() !== "GET" || /\/api\/(animate|generate|ltx)/.test(request.url())) paidRequests.push(request.url());
  });
  await page.goto("/dev/spatial-transitions/controlled");
  await expect(page.getByRole("heading", { name: "Crystal Lighthouse", exact: true })).toBeVisible();
  const videos = page.locator("video");
  await expect(videos).toHaveCount(2);
  await expect.poll(() => videos.evaluateAll(nodes => nodes.every(n => (n as HTMLVideoElement).readyState >= 2))).toBe(true);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => videos.first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("slider", { name: "Normalized progress" }).fill("0.5");
    await expect.poll(() => videos.first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeCloseTo(2.5, 1);
    await expect.poll(() => videos.evaluateAll(nodes => nodes.every(n => !(n as HTMLVideoElement).seeking))).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const layout = await page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      videos: [...document.querySelectorAll("video")].map(v => {
        const rect = v.getBoundingClientRect();
        return { width: rect.width, height: rect.height, native: v.videoWidth / v.videoHeight };
      }),
    }));
    expect(layout.width).toBeLessThanOrEqual(layout.viewport);
    for (const video of layout.videos) {
      expect(video.width).toBeGreaterThan(200);
      expect(video.width / video.height).toBeCloseTo(video.native, 2);
    }
    await page.screenshot({ path: `test-results/controlled-${viewport.width}.png`, fullPage: true });
  }
  for (const id of ["structural-60-101", "structural-35-202", "structural-60-202", "fast-101"]) {
    await page.getByRole("combobox", { name: "Configuration" }).selectOption(id);
    await expect.poll(() => videos.nth(1).evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.getByRole("slider", { name: "Normalized progress" }).fill("0.5");
    await expect.poll(() => videos.nth(1).evaluate(v => (v as HTMLVideoElement).currentTime)).toBeCloseTo(id === "fast-101" ? 3 : 2.5, 1);
    await expect.poll(() => videos.nth(1).evaluate(v => (v as HTMLVideoElement).seeking)).toBe(false);
    const pixels = await videos.nth(1).evaluate(element => {
      const video = element as HTMLVideoElement;
      const canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0, 32, 18);
      return [...context.getImageData(0, 0, 32, 18).data].filter((_, i) => i % 4 !== 3);
    });
    expect(Math.max(...pixels) - Math.min(...pixels)).toBeGreaterThan(80);
  }
  await page.screenshot({ path: "test-results/controlled-fast-390.png", fullPage: true });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => videos.first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBe(0);
  await page.reload();
  await expect(page.locator("video")).toHaveCount(2);
  expect(paidRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
