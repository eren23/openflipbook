import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_LIGHTHOUSE !== "1", "Offline landmark-guide study only");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
for (const width of [1280, 390]) test(`known-height camera, nonblank modes and stable return at ${width}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 1280 ? 784 : 844 });
  await page.goto("/dev/spatial-transitions/lighthouse");
  const canvas = page.getByRole("img", { name: "Authored Crystal Lighthouse geometry" });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(canvas).toHaveAttribute("data-camera-height", "1.65");
  const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
  const start = await pixels();
  await page.getByRole("button", { name: "Step right", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-offset", "2"); expect(await pixels()).not.toBe(start);
  await page.getByRole("button", { name: "Reset camera", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-offset", "0"); expect(await pixels()).toBe(start);
  for (const mode of ["color", "clay", "depth"]) {
    await page.getByRole("combobox", { name: "Guide mode" }).selectOption(mode);
    await expect(canvas).toHaveAttribute("data-mode", mode);
    const variance = await canvas.evaluate(el => {
      const copy = document.createElement("canvas"); copy.width = 64; copy.height = 64;
      const ctx = copy.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const values = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
      return Math.max(...values) - Math.min(...values);
    });
    expect(variance).toBeGreaterThan(35);
    await page.screenshot({ path: `test-results/lighthouse-${width}-${mode}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("export locked 1280x720 color, clay and depth inputs", async ({ page }) => {
  test.skip(process.env.E2E_LIGHTHOUSE_EXPORT !== "1", "Explicit offline asset export");
  const out = resolve("../modal-backend/tests/continuity_bench/reports/lighthouse-guides");
  await mkdir(out, { recursive: true });
  const sources = Object.fromEntries(await Promise.all(["scene.json", "world.ts", "study.tsx", "study.module.css"].map(async f => [f, hash(await readFile(`app/dev/spatial-transitions/lighthouse/${f}`))])));
  try {
    const previous = JSON.parse(await readFile(`${out}/capture.json`, "utf8"));
    expect(previous.sources).toEqual(sources);
    for (const [file, digest] of Object.entries(previous.frames)) expect(hash(await readFile(`${out}/${file}`))).toBe(digest);
    return;
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await page.setViewportSize({ width: 1280, height: 784 });
  await page.goto("/dev/spatial-transitions/lighthouse");
  const canvas = page.getByRole("img", { name: "Authored Crystal Lighthouse geometry" });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect.poll(() => canvas.evaluate(el => [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height])).toEqual([1280, 720]);
  const frames: Record<string, string> = {};
  for (const mode of ["color", "clay", "depth"]) {
    await page.getByRole("combobox", { name: "Guide mode" }).selectOption(mode);
    await expect(canvas).toHaveAttribute("data-mode", mode);
    const data = await canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
    const bytes = Buffer.from(data.split(",")[1]!, "base64"); await writeFile(`${out}/${mode}.png`, bytes); frames[`${mode}.png`] = hash(bytes);
  }
  const scene = JSON.parse(await readFile("app/dev/spatial-transitions/lighthouse/scene.json", "utf8"));
  await writeFile(`${out}/capture.json`, JSON.stringify({ sources, frames, width: 1280, height: 720, scene }, null, 2));
});

test("portable gallery renders all unmodified outputs without network access", async ({ page }) => {
  const path = process.env.E2E_LIGHTHOUSE_GALLERY;
  test.skip(!path, "Explicit offline gallery path");
  const requests: string[] = [], errors: string[] = [];
  page.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(pathToFileURL(resolve(path!, "index.html")).href);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Crystal Lighthouse: camera versus architecture");
  await expect(page.getByRole("img")).toHaveCount(11);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator("img").evaluateAll(images => images.every(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/lighthouse-gallery-${width}.png` });
    await page.getByRole("heading", { name: "Nano Banana Pro + color guide", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/lighthouse-gallery-${width}-results.png` });
  }
  for (const target of await page.locator("a[href]").evaluateAll(links => links.map(el => el.getAttribute("href")!))) {
    expect((await readFile(resolve(path!, target))).length).toBeGreaterThan(0);
  }
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});
