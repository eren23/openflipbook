import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_LIGHTHOUSE_SURFACES !== "1", "Offline surface study opt-in");
for (const width of [1280, 390]) test(`fixed surfaces, baseline equivalence and reload at ${width}`, async ({ page }) => {
  const errors: string[] = [], mutations: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { if (r.method() !== "GET") mutations.push(r.url()); });
  await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
  await page.goto("/dev/spatial-transitions/lighthouse-surfaces");
  const canvas = page.getByRole("img", { name: "Lighthouse surface comparison", exact: true });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
  const start = await pixels(), pose = await canvas.getAttribute("data-pose");
  for (const mode of ["surface", "baseline", "clay"]) {
    await page.getByRole("combobox", { name: "Surface treatment" }).selectOption(mode);
    await expect(canvas).toHaveAttribute("data-mode", mode);
    expect(await canvas.getAttribute("data-pose")).toBe(pose);
    const range = await canvas.evaluate(el => {
      const small = document.createElement("canvas"); small.width = small.height = 64;
      const ctx = small.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const values = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
      return Math.max(...values) - Math.min(...values);
    });
    expect(range).toBeGreaterThan(35);
    if (mode !== "surface") expect(await pixels()).not.toBe(start);
    await page.screenshot({ path: `test-results/lighthouse-surfaces-${width}-${mode}.png` });
  }
  await page.getByRole("combobox", { name: "Surface treatment" }).selectOption("surface");
  expect(await pixels()).toBe(start);
  await page.getByRole("button", { name: "Side view", exact: true }).click();
  const side = await pixels(); expect(side).not.toBe(start);
  await page.reload(); await expect(canvas).toHaveAttribute("data-time", "6.000"); expect(await pixels()).toBe(side);
  await page.getByRole("button", { name: "Arcade approach", exact: true }).click();
  await page.screenshot({ path: `test-results/lighthouse-surfaces-${width}-approach.png` });
  await page.getByRole("button", { name: "Return", exact: true }).click(); expect(await pixels()).toBe(start);
  await page.getByRole("combobox", { name: "Camera view" }).selectOption("inspection");
  await page.screenshot({ path: `test-results/lighthouse-surfaces-${width}-inspection.png` });
  await page.getByRole("button", { name: "Source review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Source review" })).toBeVisible();
  await expect.poll(() => page.getByAltText("Original lighthouse architecture and illustrated palette").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(173);
  await page.getByRole("button", { name: "Close source review", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Return to arrival", exact: true }).click();
  await page.getByRole("combobox", { name: "Surface treatment" }).selectOption("baseline");
  const baseline = await pixels();
  await page.goto("/dev/spatial-transitions/lighthouse-v2");
  const old = page.getByRole("img", { name: "Persistent lighthouse scene", exact: true });
  await expect(old).toHaveAttribute("data-ready", "true");
  expect(await old.evaluate(el => (el as HTMLCanvasElement).toDataURL())).toBe(baseline);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(mutations).toEqual([]);
});

test("export paired appearance frames from identical cameras", async ({ page }) => {
  test.skip(process.env.E2E_LIGHTHOUSE_SURFACES_EXPORT !== "1", "Explicit offline export");
  const out = resolve("../modal-backend/tests/continuity_bench/reports/lighthouse-surfaces-v1"); await mkdir(out, { recursive: true });
  const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const sources = Object.fromEntries(await Promise.all(["appearance.json", "world.ts", "state.ts", "study.tsx"].map(async file => [file, hash(await readFile(`app/dev/spatial-transitions/lighthouse-surfaces/${file}`))])));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dev/spatial-transitions/lighthouse-surfaces");
  const canvas = page.getByRole("img", { name: "Lighthouse surface comparison", exact: true }); await expect(canvas).toHaveAttribute("data-ready", "true");
  const height = await canvas.evaluate(el => el.clientHeight); await page.setViewportSize({ width: 1280, height: 900 + 720 - height });
  const frames: Record<string, unknown> = {};
  for (const [name, time, view] of [["arrival", 0, "walk"], ["side", 6, "walk"], ["approach", 12, "walk"], ["return", 24, "walk"], ["inspection", 0, "inspection"]] as const) {
    await page.getByRole("button", { name: "Return to arrival", exact: true }).click();
    await page.getByRole("slider", { name: "Route position" }).fill(String(time));
    await page.getByRole("combobox", { name: "Camera view" }).selectOption(view);
    for (const mode of ["baseline", "surface"]) {
      await page.getByRole("combobox", { name: "Surface treatment" }).selectOption(mode);
      const data = await canvas.evaluate(el => ({ image: (el as HTMLCanvasElement).toDataURL(), width: (el as HTMLCanvasElement).width, height: (el as HTMLCanvasElement).height }));
      expect([data.width, data.height]).toEqual([1280, 720]);
      const bytes = Buffer.from(data.image.split(",")[1]!, "base64"), key = `${name}-${mode}`;
      await writeFile(`${out}/${key}.png`, bytes); frames[key] = { sha256: hash(bytes), pose: JSON.parse((await canvas.getAttribute("data-pose"))!), time, view, mode };
    }
  }
  await writeFile(`${out}/capture.json`, JSON.stringify({ sources, frames, paid_calls: 0, geometry_changed: false, accepted: false }, null, 2));
});

test("record the full fixed-surface route and unchanged return", async ({ browser, baseURL }) => {
  test.skip(process.env.E2E_LIGHTHOUSE_SURFACES_FILM !== "1", "Explicit local recording");
  if (!baseURL) throw new Error("A local study URL is required");
  const dir = resolve("../modal-backend/tests/continuity_bench/reports/lighthouse-surfaces-v1");
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, recordVideo: { dir, size: { width: 1280, height: 900 } } });
  const page = await context.newPage(), video = page.video()!, errors: string[] = [], mutations: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { if (r.method() !== "GET") mutations.push(r.url()); });
  try {
    await page.goto("/dev/spatial-transitions/lighthouse-surfaces");
    const canvas = page.getByRole("img", { name: "Lighthouse surface comparison", exact: true });
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
    const start = await pixels();
    await page.getByRole("button", { name: "Play route", exact: true }).click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-time")), { timeout: 15000 }).toBeGreaterThan(6);
    expect(await pixels()).not.toBe(start);
    await expect(canvas).toHaveAttribute("data-time", "24.000", { timeout: 35000 });
    expect(await pixels()).toBe(start);
    expect(errors).toEqual([]); expect(mutations).toEqual([]);
  } finally { await context.close(); }
  await video.saveAs(`${dir}/walkthrough.webm`);
});

test("offline comparison images, video and links work on desktop and mobile", async ({ page }) => {
  const dir = process.env.E2E_LIGHTHOUSE_SURFACES_GALLERY;
  test.skip(!dir, "Explicit local gallery path");
  const requests: string[] = []; page.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.goto(pathToFileURL(resolve(dir!, "index.html")).href);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lighthouse surfaces");
  await expect(page.getByRole("img")).toHaveCount(11);
  await expect.poll(() => page.locator("img").evaluateAll(images => images.every(el => (el as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect.poll(() => page.locator("video").evaluate(el => (el as HTMLVideoElement).duration)).toBeGreaterThan(24);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/lighthouse-surfaces-gallery-${width}.png` });
  }
  for (const href of await page.locator("a[href]").evaluateAll(links => links.map(el => el.getAttribute("href")!))) {
    if (!/^https?:/.test(href)) expect((await readFile(resolve(dir!, href))).length).toBeGreaterThan(0);
  }
  expect(requests).toEqual([]);
});
