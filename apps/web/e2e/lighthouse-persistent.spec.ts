import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_LIGHTHOUSE_V2 !== "1", "Opt-in offline persistent scene");
for (const width of [1280, 390]) test(`persistent geometry, camera return and reload at ${width}`, async ({ page }) => {
  const errors: string[] = [], mutations: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (r.method() !== "GET") mutations.push(`${r.method()} ${r.url()}`); });
  await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
  await page.goto("/dev/spatial-transitions/lighthouse-v2");
  const canvas = page.getByRole("img", { name: "Persistent lighthouse scene", exact: true });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(canvas).toHaveAttribute("data-scene", "crystal-lighthouse-local-v2");
  const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
  const start = await pixels(), matrix = await canvas.getAttribute("data-pose");
  for (const label of ["Arrival", "Side view", "Arcade approach", "Outside", "Return"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(canvas).toHaveAttribute("data-height", "1.65");
    await page.screenshot({ path: `test-results/lighthouse-v2-${width}-${label.replaceAll(" ", "-")}.png` });
    if (label === "Return") { expect(await pixels()).toBe(start); expect(await canvas.getAttribute("data-pose")).toBe(matrix); }
    else if (label !== "Arrival") expect(await pixels()).not.toBe(start);
  }
  await page.getByRole("button", { name: "Side view", exact: true }).click();
  const side = await pixels(); await page.reload();
  await expect(canvas).toHaveAttribute("data-time", "6.000"); expect(await pixels()).toBe(side);
  await page.getByRole("button", { name: "Play route", exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-time"))).toBeGreaterThan(6.1);
  await page.getByRole("button", { name: "Pause route", exact: true }).click();
  const paused = await canvas.getAttribute("data-time");
  await page.reload(); await expect(canvas).toHaveAttribute("data-time", paused!);
  await page.getByRole("button", { name: "Return to arrival", exact: true }).click();
  for (const mode of ["color", "clay", "depth"]) {
    await page.getByRole("combobox", { name: "Render mode" }).selectOption(mode);
    await expect(canvas).toHaveAttribute("data-mode", mode);
    const range = await canvas.evaluate(el => {
      const small = document.createElement("canvas"); small.width = small.height = 64;
      const ctx = small.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const bytes = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
      return Math.max(...bytes) - Math.min(...bytes);
    });
    expect(range).toBeGreaterThan(35);
  }
  await page.getByRole("combobox", { name: "Render mode" }).selectOption("color");
  await page.getByRole("combobox", { name: "Camera view" }).selectOption("inspection");
  await page.screenshot({ path: `test-results/lighthouse-v2-${width}-inspection.png` });
  await page.getByRole("button", { name: "Source evidence", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => page.getByAltText(/Original Crystal Lighthouse/).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(173);
  await page.screenshot({ path: `test-results/lighthouse-v2-${width}-evidence.png` });
  await page.getByRole("button", { name: "Close source evidence", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(mutations).toEqual([]);
});

test("export source-bound scene and viewpoint receipts", async ({ page }) => {
  test.skip(process.env.E2E_LIGHTHOUSE_V2_EXPORT !== "1", "Explicit offline export");
  const out = resolve("../modal-backend/tests/continuity_bench/reports/lighthouse-persistent-v2");
  await mkdir(out, { recursive: true });
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const sources = Object.fromEntries(await Promise.all(["scene.json", "contract.ts", "world.ts", "study.tsx", "study.module.css", "reference.png"].map(async name => [name, hash(await readFile(`app/dev/spatial-transitions/lighthouse-v2/${name}`))])));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dev/spatial-transitions/lighthouse-v2");
  const canvas = page.getByRole("img", { name: "Persistent lighthouse scene", exact: true });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const height = await canvas.evaluate(el => el.clientHeight);
  await page.setViewportSize({ width: 1280, height: 900 + 720 - height });
  const frames: Record<string, unknown> = {};
  for (const [name, time, view] of [["arrival", 0, "walk"], ["side", 6, "walk"], ["approach", 12, "walk"], ["outside", 16, "walk"], ["return", 24, "walk"], ["inspection", 0, "inspection"]] as const) {
    await page.getByRole("button", { name: "Return to arrival", exact: true }).click();
    await page.getByRole("slider", { name: "Route position" }).fill(String(time));
    await page.getByRole("combobox", { name: "Camera view" }).selectOption(view);
    await expect(canvas).toHaveAttribute("data-view", view);
    const data = await canvas.evaluate(el => ({ image: (el as HTMLCanvasElement).toDataURL(), width: (el as HTMLCanvasElement).width, height: (el as HTMLCanvasElement).height }));
    expect([data.width, data.height]).toEqual([1280, 720]);
    const bytes = Buffer.from(data.image.split(",")[1]!, "base64");
    await writeFile(`${out}/${name}.png`, bytes);
    frames[name] = { sha256: hash(bytes), time, view, pose: JSON.parse((await canvas.getAttribute("data-pose"))!) };
  }
  await writeFile(`${out}/capture.json`, JSON.stringify({ sources, frames, authored: true, reconstruction: false, paid_calls: 0 }, null, 2));
});

test("uncut route playback from the same scene returns without generation", async ({ browser, baseURL }) => {
  test.skip(process.env.E2E_LIGHTHOUSE_V2_FILM !== "1", "Explicit offline browser recording");
  if (!baseURL) throw new Error("A local study base URL is required");
  const dir = resolve("../modal-backend/tests/continuity_bench/reports/lighthouse-persistent-v2");
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, recordVideo: { dir, size: { width: 1280, height: 900 } } });
  const page = await context.newPage(), video = page.video()!;
  const mutations: string[] = [];
  page.on("request", r => { if (r.method() !== "GET") mutations.push(r.url()); });
  try {
    await page.goto("/dev/spatial-transitions/lighthouse-v2");
    const canvas = page.getByRole("img", { name: "Persistent lighthouse scene", exact: true });
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL());
    const start = await pixels();
    await page.getByRole("button", { name: "Play route", exact: true }).click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-time")), { timeout: 15000 }).toBeGreaterThan(6);
    expect(await pixels()).not.toBe(start);
    await expect(canvas).toHaveAttribute("data-time", "24.000", { timeout: 35000 });
    expect(await pixels()).toBe(start);
    expect(mutations).toEqual([]);
  } finally { await context.close(); }
  await video.saveAs(`${dir}/walkthrough.webm`);
});
