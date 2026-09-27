import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_GEOMETRY !== "1", "Local 3D study only, no provider calls");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

for (const size of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test(`3D movement, stable return, clay and manual controls at ${size.width}`, async ({ page }) => {
    const errors: string[] = [], paid: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", req => { if (/\/api\/(generate|animate|ltx)/.test(req.url()) || req.method() !== "GET") paid.push(req.url()); });
    await page.setViewportSize(size);
    await page.goto("/dev/spatial-transitions/geometry");
    const canvas = page.getByRole("img", { name: "Quayside three-dimensional scene" });
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL("image/png"));
    const first = await pixels();
    await page.screenshot({ path: `test-results/geometry-${size.width}-quay.png` });
    for (const time of [2, 5.5, 7.5, 10, 12.5, 15, 20]) {
      await page.getByRole("slider", { name: "Journey time" }).fill(String(time));
      await expect(canvas).toHaveAttribute("data-time", time.toFixed(6));
      const frame = await pixels();
      if (time === 20) expect(frame).toBe(first); else expect(frame).not.toBe(first);
      if (time === 10 || time === 12.5) await page.screenshot({ path: `test-results/geometry-${size.width}-${time}.png` });
    }
    await page.getByRole("button", { name: "Clay", exact: true }).click();
    await expect(canvas).toHaveAttribute("data-mode", "clay");
    expect(await pixels()).not.toBe(first);
    await page.getByRole("button", { name: "Illustrated", exact: true }).click();
    expect(await pixels()).toBe(first);
    await page.getByRole("button", { name: "Step right", exact: true }).click();
    expect(await pixels()).not.toBe(first);
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    expect(await pixels()).toBe(first);
    await page.getByRole("button", { name: "Play journey", exact: true }).click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-time"))).toBeGreaterThan(.2);
    await page.getByRole("button", { name: "Pause journey", exact: true }).click();
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      canvas: document.querySelector("canvas")!.getBoundingClientRect().toJSON(),
      buttons: [...document.querySelectorAll("main button")].map(b => b.getBoundingClientRect().toJSON()) }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.width);
    expect(layout.canvas.width).toBe(size.width);
    expect(layout.canvas.height).toBeGreaterThan(500);
    for (const box of layout.buttons) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(size.width); }
    const colors = await canvas.evaluate(el => {
      const copy = document.createElement("canvas"); copy.width = 64; copy.height = 36;
      const ctx = copy.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 36);
      return [...ctx.getImageData(0, 0, 64, 36).data].filter((_, i) => i % 4 !== 3);
    });
    expect(Math.max(...colors) - Math.min(...colors)).toBeGreaterThan(120);
    await page.reload();
    await expect(canvas).toHaveAttribute("data-ready", "true");
    expect(await pixels()).toBe(first);
    expect(errors).toEqual([]); expect(paid).toEqual([]);
  });
}

test("export deterministic RGB and clay camera frames for video comparison", async ({ page }) => {
  test.skip(process.env.E2E_GEOMETRY_EXPORT !== "1", "Explicit offline export only");
  test.setTimeout(600_000);
  const out = resolve("../modal-backend/tests/video_transition_bench/reports/geometry-quay/inputs");
  const sources = ["scene.json", "contract.ts", "world.ts", "study.tsx"];
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async name => [name,
    hash(await readFile(`app/dev/spatial-transitions/geometry/${name}`))])));
  try {
    const previous = JSON.parse(await readFile(resolve(out, "capture.json"), "utf8"));
    expect(previous.sources).toEqual(sourceHashes);
    for (const [name, digest] of Object.entries(previous.frames)) expect(hash(await readFile(resolve(out, name)))).toBe(digest);
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await page.setViewportSize({ width: 1344, height: 940 });
  await page.goto("/dev/spatial-transitions/geometry");
  const canvas = page.getByRole("img", { name: "Quayside three-dimensional scene" });
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const chrome = await page.evaluate(() => innerHeight - document.querySelector("canvas")!.getBoundingClientRect().height);
  await page.setViewportSize({ width: 1344, height: 768 + chrome });
  await expect.poll(() => canvas.evaluate(el => [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height])).toEqual([1344, 768]);
  const frames: Record<string, string> = {};
  for (const mode of ["illustrated", "clay"] as const) {
    await mkdir(resolve(out, mode), { recursive: true });
    await page.getByRole("button", { name: mode === "clay" ? "Clay" : "Illustrated", exact: true }).click();
    await expect(canvas).toHaveAttribute("data-mode", mode);
    const count = mode === "illustrated" ? 481 : 241;
    for (let i = 0; i < count; i++) {
      const time = (i / 24).toFixed(6);
      await page.getByRole("slider", { name: "Journey time" }).fill(time);
      await expect(canvas).toHaveAttribute("data-time", time);
      const data = await canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL("image/png"));
      const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
      const name = `${mode}/${String(i).padStart(4, "0")}.png`;
      await writeFile(resolve(out, name), bytes); frames[name] = hash(bytes);
      if (i % 120 === 0) console.warn(`Captured ${mode}: ${i}/${count - 1}`);
    }
  }
  expect(frames["illustrated/0000.png"]).toBe(frames["illustrated/0480.png"]);
  const scene = JSON.parse(await readFile("app/dev/spatial-transitions/geometry/scene.json", "utf8"));
  await writeFile(resolve(out, "capture.json"), JSON.stringify({ version: 1, sources: sourceHashes, scene,
    width: 1344, height: 768, fps: 24, outbound_frames: 241, roundtrip_frames: 481,
    exact_raw_return: true, frames }, null, 2));
});
