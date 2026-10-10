import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { releaseDistrict } from "../tests/fixtures/release-district";
import { assertSelfhostReceipt } from "./selfhost-environment";

const recording = process.env.E2E_SELFHOST_VIDEO === "1";
test.use(recording ? { video: { mode: "on", size: { width: 1280, height: 900 } }, launchOptions: { slowMo: 180 } } : {});
test.skip(process.env.E2E_SELFHOST !== "1", "Requires the isolated credential-free selfhost check");
for (const [width, style] of [[1280, "fantasy"], [390, "contemporary"]] as const) test(`selected immutable district publication and private fork at ${width}`, async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const receipt = JSON.parse(await readFile(process.env.E2E_SELFHOST_RECEIPT!, "utf8"));
  assertSelfhostReceipt(receipt, baseURL);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  expect((await page.request.post("/api/creator/identity", { data: {} })).status()).toBe(200);
  const definition = releaseDistrict(style);
  const created = await page.request.post("/api/creator/worlds", { data: { request_id: crypto.randomUUID(), definition } });
  expect(created.status(), await created.text()).toBe(200); const world = await created.json(), sid = world.session_id, pid = world.scene.place_id;
  expect(definition.objects.filter(x => x.kind === "building")).toHaveLength(8);
  await page.goto(`/sketch/world?world=${sid}&place=${pid}`);
  await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  const building = definition.objects.find(o => o.structure?.floors.length === 2)!;
  const upper = building.structure!.floors[1]!.id;
  await page.getByRole("button", { name: `${building.label} building`, exact: true }).click();
  await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption(upper);
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  await page.getByTestId("place-viewport").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath(`district-${style}-${width}-upper.png`) });
  const views = page.getByRole("region", { name: "Saved camera views", exact: true });
  await views.getByLabel("View name", { exact: true }).fill("Upper room camera");
  await views.getByRole("button", { name: "Save camera view", exact: true }).click();
  await expect(views.getByRole("status").filter({ hasText: /^Current geometry/ })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("combobox", { name: "Editing floor", exact: true })).toHaveValue(upper);
  await expect(page.getByLabel("Object name", { exact: true })).toHaveValue(building.label);
  await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption("");
  await page.getByText("Publish selected world content", { exact: true }).click();
  await page.getByLabel("Public title", { exact: true }).fill(`${definition.label} public snapshot`);
  await page.getByRole("checkbox", { name: definition.label, exact: true }).check();
  await page.getByRole("checkbox", { name: "Upper room camera", exact: true }).check();
  const response = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/api/world/${sid}/publications`));
  await page.getByRole("button", { name: "Publish selected snapshot", exact: true }).click();
  const published = await response; expect(published.status(), await published.text()).toBe(200); const snapshot = (await published.json()).publication;
  const visitor = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
    ...(recording ? { recordVideo: { dir: test.info().outputPath("visitor-video"), size: { width, height: width === 390 ? 844 : 900 } } } : {}) });
  try { const shared = await visitor.newPage(); shared.on("pageerror", e => errors.push(e.message)); await shared.goto(`${baseURL}/w/${snapshot.id}`);
    await expect(shared.getByRole("heading", { name: `${definition.label} public snapshot`, exact: true })).toBeVisible();
    await expect(shared.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
    const publicCanvas = shared.getByTestId("place-viewport").locator("canvas");
    await expect.poll(async () => (await publicCanvas.boundingBox())?.height ?? 0).toBeGreaterThan(300);
    await expect.poll(() => publicCanvas.evaluate(el => {
      const copy = document.createElement("canvas"); copy.width = copy.height = 64;
      const ctx = copy.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data; const min = [255, 255, 255], max = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) {
        min[channel] = Math.min(min[channel]!, data[i + channel]!); max[channel] = Math.max(max[channel]!, data[i + channel]!);
      }
      return Math.max(...max.map((value, channel) => value - min[channel]!));
    })).toBeGreaterThan(30);
    expect(await shared.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await shared.request.get(`/api/world/${sid}`)).status()).toBe(403);
    await shared.screenshot({ path: test.info().outputPath(`district-${style}-${width}-published.png`) });
    // The app navigates as soon as it reads this acknowledgement. Retain the
    // actual server response before delivery so CDP cannot lose its body.
    let forkAcknowledgement: { status: number; body: string } | undefined;
    await shared.route(`**/api/publications/${snapshot.id}/fork`, async route => {
      const response = await route.fetch(); const body = await response.text();
      forkAcknowledgement = { status: response.status(), body };
      await route.fulfill({ response, body });
    }); // Keep interception stable through the app's immediate navigation.
    const fork = shared.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/api/publications/${snapshot.id}/fork`));
    await shared.getByRole("button", { name: "Fork selected content", exact: true }).click();
    const copied = await fork; expect(copied.status()).toBe(200);
    const acknowledgement = forkAcknowledgement; if (!acknowledgement) throw new Error("Fork server acknowledgement missing");
    expect(acknowledgement.status, acknowledgement.body).toBe(200); const destination = JSON.parse(acknowledgement.body).session_id;
    await expect(shared).toHaveURL(new RegExp(`world=${destination}`)); await expect(shared.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
    const own = await shared.request.get(`/api/world/${destination}/places/${pid}/scene`); expect(own.status()).toBe(200);
    const restored = await own.json(); expect(restored.scene.definition).toEqual(definition);
    expect((await page.request.get(`/api/world/${destination}`)).status()).toBe(403);
    const withdrawn = await page.request.delete(`/api/world/${sid}/publications?id=${snapshot.id}`, { headers: { "Content-Type": "application/json" } }); expect(withdrawn.status()).toBe(200);
    expect((await shared.request.get(`/w/${snapshot.id}`)).status()).toBe(404);
    expect((await shared.request.get(`/api/world/${destination}/places/${pid}/scene`)).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally { await visitor.close(); }
});
