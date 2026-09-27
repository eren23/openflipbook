import { chromium, expect as baseExpect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const expect = baseExpect.configure({ timeout: 120000 });

const proof = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const receipt = JSON.parse(await readFile(`${proof}/receipt.json`, "utf8"));
await mkdir(output);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: "http://127.0.0.1:3003", viewport: { width: 1600, height: 1000 }, recordVideo: { dir: output, size: { width: 1600, height: 1000 } } });
const page = await context.newPage(), video = page.video(), events = [], errors = [];
page.setDefaultTimeout(120000);
const started = performance.now(), pause = ms => page.waitForTimeout(ms);
const event = name => { events.push({ name, seconds: (performance.now() - started) / 1000 }); console.log(name); };
let calls = 0, status = "failed";
let tourSource = receipt.source, tourSession = receipt.session_id;
await page.route("**/api/generate-page", route => { calls++; return route.abort(); });
const imageReady = async locator => {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(i => i.complete && i.naturalWidth > 0), { timeout: 120000 }).toBe(true);
};
const readyScene = async () => {
  const views = page.getByTestId("place-viewport");
  await expect.poll(() => views.count()).toBeGreaterThan(0);
  for (const view of await views.all()) await expect(view).toHaveAttribute("data-ready", "true");
};
const click = async name => { await page.getByRole("button", { name, exact: true }).click(); await pause(1000); };
const stable = async () => { await imageReady(page.locator('img[alt^="Generated illustration"]').first()); await pause(1800); };
const visit = async name => {
  // Spatial minimap tiles can overlap. Native keyboard selection remains
  // accessible without force-clicking through another tile.
  const button = page.getByRole("button", { name, exact: true }).last();
  await button.focus(); await button.press("Enter");
  await stable(); event(name); await pause(3000);
};
try {
  // Use the real public fork workflow to acquire an editable copy, never
  // copying owner credentials from the isolated creation recording.
  await page.goto(`/n/${receipt.source}`);
  await page.getByRole("button", { name: "Fork this world", exact: true }).click();
  await page.waitForURL("**/play?continue=**");
  tourSession = new URL(page.url()).searchParams.get("continue");
  const graph = await (await page.request.get(`/api/sessions/${tourSession}`)).json();
  expect(graph.nodes).toHaveLength(10);
  tourSource = graph.nodes.find(n => n.page_title === "The Mended Drum").id;
  event("fork_saved_world");
  await page.goto(`/sketch/world/ankh?source=${tourSource}&view=map`);
  await imageReady(page.getByRole("img", { name: "Ankh-Morpork city map" })); event("saved_map"); await pause(3000);
  await click("Focus Mended Drum"); await pause(1800);
  const versions = page.getByRole("combobox", { name: "Map artwork version" });
  const keptId = await versions.inputValue();
  await versions.selectOption({ label: "Original map" }); await imageReady(page.getByRole("img", { name: "Ankh-Morpork city map" })); await pause(2200);
  await versions.selectOption(keptId); await imageReady(page.getByRole("img", { name: "Ankh-Morpork city map" })); event("saved_repaint"); await pause(2600);
  await click("Street"); await imageReady(page.getByRole("img", { name: "The Mended Drum on Filigree Street" })); event("street"); await pause(3000);
  await page.getByRole("link", { name: "3D materials and alignment", exact: true }).click(); await readyScene();
  await click("Plan + 3D"); await readyScene();
  await click("The Mended Drum tavern"); await click("Frame selected in 3D"); await pause(2500);
  await page.screenshot({ path: `${output}/geometry.png` }); event("saved_geometry");
  const canvas = page.getByRole("region", { name: "Live 3D", exact: true }).locator("canvas");
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .5); await page.mouse.down();
  for (let i = 1; i <= 45; i++) { await page.mouse.move(bounds.x + bounds.width * (.55 + .12 * i / 45), bounds.y + bounds.height * (.5 + .035 * i / 45)); await pause(35); }
  await page.mouse.up(); await pause(2200); await page.screenshot({ path: `${output}/geometry-orbit.png` });
  await page.getByRole("link", { name: "Explore world", exact: true }).click(); await stable();
  const codex = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  if (await codex.isVisible()) await codex.getByRole("button", { name: "Close", exact: true }).click();
  const labels = page.getByRole("button", { name: "labels", exact: true });
  if (await labels.getAttribute("aria-pressed") === "true") await labels.click();
  await visit("Inside The Mended Drum Tavern"); await page.screenshot({ path: `${output}/tavern.png` });
  await click("← back"); await stable();
  await visit("Eastward");
  await visit("Craftsman Workshop by the Well"); await page.screenshot({ path: `${output}/workshop.png` });
  await click("← back"); await stable();
  for (const direction of ["Westward", "Northward", "Southward"]) await visit(direction);
  await page.goto(await page.getByRole("link", { name: "↗ atlas", exact: true }).getAttribute("href"));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await pause(5000);
  await page.screenshot({ path: `${output}/atlas.png` }); event("atlas");
  expect(calls).toBe(0); status = "complete";
} catch (error) { errors.push(String(error)); console.error(error.message); process.exitCode = 1; }
finally {
  await context.close(); await video.saveAs(`${output}/uncut.webm`); await browser.close();
  await writeFile(`${output}/receipt.json`, JSON.stringify({ status, errors, events, generation_submissions: calls, session_id: tourSession, source: tourSource, forked_from: receipt.session_id, recording: "One continuous full-viewport browser recording of SAVED results. No cuts, cropping, retiming or generation. Creation and editing are in the separate long proof recording." }, null, 2));
}
