/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { MongoClient } from "mongodb";

test.skip(process.env.E2E_WORLD_SCENES !== "1", "Opt-in free world-scene checks");
const ready = async (page: Page) => { await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true"); };
const pixels = async (page: Page) => page.getByTestId("place-viewport").locator("canvas").evaluate(el => (el as HTMLCanvasElement).toDataURL());
const camera = async (page: Page) => (await page.getByTestId("place-viewport").getAttribute("data-camera"))!.split(",").map(Number);

for (const width of [1280, 390]) test(`garden plan, actual movement and return at ${width}`, async ({ page }) => {
  const errors: string[] = [], generation: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/generate-page", route => { generation.push(route.request().url()); return route.abort(); });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto("/sketch/world?demo=1"); await ready(page);
  const plan = await pixels(page);
  const range = await page.getByTestId("place-viewport").locator("canvas").evaluate(el => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const bytes = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
    return Math.max(...bytes) - Math.min(...bytes);
  });
  expect(range).toBeGreaterThan(50);
  await page.screenshot({ path: `test-results/world-garden-${width}-plan.png` });
  await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(page);
  expect(await pixels(page)).not.toBe(plan);
  await page.screenshot({ path: `test-results/world-garden-${width}-3d.png` });
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(page);
  await expect.poll(async () => (await camera(page))[1]).toBe(1.6);
  const initial = await camera(page), start = await pixels(page);
  await page.keyboard.down("a");
  await expect.poll(async () => (await camera(page))[0]).toBeLessThan(initial[0]! - 1);
  await page.keyboard.up("a"); expect(await pixels(page)).not.toBe(start);
  await page.getByRole("button", { name: "Return to entrance", exact: true }).click(); await ready(page);
  await expect.poll(() => camera(page)).toEqual(initial);
  if (width === 1280) {
    await page.keyboard.down("w");
    await expect.poll(async () => (await camera(page))[2], { timeout: 15000 }).toBeLessThan(0.9);
    // Keep pushing against the north wall after contact, then inspect clearance.
    await page.waitForTimeout(600); await page.keyboard.up("w");
    expect((await camera(page))[2]).toBeGreaterThan(0.7);
    await page.getByRole("button", { name: "Return to entrance", exact: true }).click(); await ready(page);
  }
  await page.screenshot({ path: `test-results/world-garden-${width}-walk.png` });
  await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(page);
  expect(await pixels(page)).toBe(plan);
  await page.getByRole("button", { name: "Bench bench", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Object x", exact: true }).fill("15");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply to world" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(generation).toEqual([]);
});

test("real Mongo scene apply, reload, undo and no-generation recording", async ({ browser, baseURL }) => {
  test.skip(process.env.E2E_WORLD_SCENES_LIVE_DB !== "1", "Explicit isolated fixture in configured database");
  if (!baseURL || !new URL(baseURL).hostname.match(/^(localhost|127\.0\.0\.1)$/)) throw new Error("Local web server required");
  process.loadEnvFile(".env.local");
  const sourceSession = process.env.WORLD_SCENE_SOURCE_SESSION;
  if (!sourceSession || !process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new Error("Configured source session and database required");
  const client = new MongoClient(process.env.MONGODB_URI); await client.connect();
  const db = client.db(process.env.MONGODB_DB), sid = `scene_test_${randomUUID()}`, nodeId = randomUUID(), token = randomUUID();
  const out = resolve("test-results/world-scene-live"); await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 900 } } });
  const page = await context.newPage(), video = page.video()!, mutations: string[] = [];
  const cleanup = async () => {
    for (const name of ["nodes", "place_scenes", "place_scene_versions", "world_edit_proposals"]) await db.collection(name).deleteMany({ session_id: sid });
    for (const name of ["world_map", "world_state", "session_owners"]) await db.collection(name).deleteOne({ _id: sid as never });
  };
  try {
    const source = await db.collection("nodes").findOne({ session_id: sourceSession });
    if (!source?.image_key) throw new Error("Source image not found");
    await db.collection("nodes").insertOne({ ...source, _id: nodeId as never, session_id: sid, parent_id: null, page_title: "Garden integration test", scene_outdated: false });
    await db.collection("session_owners").insertOne({ _id: sid as never, owner_token: token, created_at: new Date() });
    await context.addCookies([{ name: "ofb_owner", value: token, url: baseURL }]);
    await page.route("**/api/generate-page", route => { mutations.push(route.request().url()); return route.abort(); });
    await page.goto(`/sketch/world?source=${nodeId}`); await ready(page);
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world" }).click();
    await expect(page.getByRole("status")).toHaveText("Revision 1 · Saved");
    await page.getByRole("button", { name: "Reference", exact: true }).click();
    await expect.poll(() => page.getByAltText("Saved source illustration").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Bench bench", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Object x", exact: true }).fill("15");
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world" }).click();
    await expect(page.getByRole("status")).toHaveText("Revision 2 · Saved");
    await page.reload(); await ready(page); await page.getByRole("button", { name: "Bench bench", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Object x", exact: true })).toHaveValue("15");
    const stored = await db.collection("place_scenes").findOne({ session_id: sid });
    expect(stored?.revision).toBe(2); expect(stored?.definition.objects.find((o: any) => o.kind === "bench").x).toBe(15);
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(page);
    const initial = await camera(page); await page.keyboard.down("d");
    await expect.poll(async () => (await camera(page))[0]).toBeGreaterThan(initial[0]! + 1);
    await page.keyboard.up("d"); await page.getByRole("button", { name: "Return to entrance" }).click(); await ready(page);
    await page.screenshot({ path: `${out}/saved-garden.png` });
    await page.getByRole("combobox", { name: "Restore revision" }).selectOption("1");
    await page.getByRole("button", { name: "Apply to world" }).click(); await expect(page.getByRole("status")).toHaveText("Revision 3 · Saved");
    expect((await db.collection("place_scenes").findOne({ session_id: sid }))?.definition.objects.find((o: any) => o.kind === "bench").x).toBe(14);
    expect(await db.collection("place_scene_versions").countDocuments({ session_id: sid })).toBe(3);
    expect(mutations).toEqual([]);
  } finally {
    await context.close(); await video.saveAs(`${out}/edit-walk-uncut.webm`); await cleanup(); await client.close();
  }
});
