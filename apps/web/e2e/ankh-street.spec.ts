import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_WORLD_SCENES !== "1", "Opt-in free street checks");
for (const width of [1280, 390]) test(`Mended Drum anchored approach and return ${width}`, async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("A local test base URL is required");
  const out = `test-results/ankh-${width}`; await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width, height: width === 390 ? 844 : 900 }, recordVideo: { dir: out, size: { width, height: width === 390 ? 844 : 900 } } });
  const page = await context.newPage(), video = page.video()!, errors: string[] = [], generations: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/generate-page", route => { generations.push(route.request().url()); return route.abort(); });
  const viewport = page.getByTestId("place-viewport");
  const ready = () => expect(viewport).toHaveAttribute("data-ready", "true");
  const camera = async () => (await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const pixels = () => viewport.locator("canvas").evaluate(el => (el as HTMLCanvasElement).toDataURL());
  try {
    await page.goto("/sketch/world?demo=ankh");
    const map = page.getByAltText("Saved source illustration");
    await expect.poll(() => map.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(1000);
    const mapSrc = await map.getAttribute("src");
    await page.screenshot({ path: `${out}/01-map.png` });
    await page.getByRole("button", { name: "Focus Mended Drum", exact: true }).click();
    await expect.poll(() => map.evaluate(el => getComputedStyle(el).transform)).toBe("matrix(4, 0, 0, 4, 0, 0)");
    await page.screenshot({ path: `${out}/02-map-detail.png` });
    await page.getByRole("button", { name: "Enter street", exact: true }).click(); await ready();
    const start = await pixels();
    await expect.poll(async () => (await camera())[0], { timeout: 20000 }).toBeLessThan(30);
    expect(await pixels()).not.toBe(start);
    await page.screenshot({ path: `${out}/03-approach.png` });
    await expect.poll(async () => (await camera())[2], { timeout: 30000 }).toBeGreaterThan(11.9);
    await page.screenshot({ path: `${out}/04-door.png` });
    await expect(viewport).toHaveAttribute("data-route-state", "complete", { timeout: 20000 });
    const final = await camera();
    expect(final[0]).toBeCloseTo(12.6, 1); expect(final[2]).toBeCloseTo(12, 1); expect(final[1]).toBeCloseTo(1.6, 2);
    await page.screenshot({ path: `${out}/05-look-back.png` });
    const range = await viewport.locator("canvas").evaluate(el => {
      const copy = document.createElement("canvas"); copy.width = copy.height = 64;
      const ctx = copy.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const data = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
      return Math.max(...data) - Math.min(...data);
    });
    expect(range).toBeGreaterThan(70);
    // East-facing: right strafe moves south into the closed north facade.
    await page.keyboard.down("d"); await page.waitForTimeout(1200); await page.keyboard.up("d");
    expect((await camera())[2]).toBeLessThan(12.71);
    await page.getByRole("button", { name: "Return to entrance", exact: true }).click(); await ready();
    await expect.poll(async () => (await camera())[0]).toBeCloseTo(34.2, 2);
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(); const plan = await pixels();
    await page.screenshot({ path: `${out}/06-plan.png` });
    await page.getByRole("button", { name: "3D", exact: true }).click(); await ready();
    await page.screenshot({ path: `${out}/07-orbit.png` });
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(); expect(await pixels()).toBe(plan);
    await page.getByRole("button", { name: "Reference", exact: true }).click();
    await page.getByRole("button", { name: "Show whole map", exact: true }).click();
    await expect.poll(() => map.evaluate(el => getComputedStyle(el).transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(await map.getAttribute("src")).toBe(mapSrc);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(generations).toEqual([]);
  } finally { await context.close(); await video.saveAs(`${out}/journey-uncut.webm`); }
});
