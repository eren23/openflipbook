import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:3003";
if (new URL(base).hostname !== "127.0.0.1") throw new Error("Local proof only");
const output = resolve(process.argv[2] || "../../docs/research/assets/drum-geometry");
const connected = process.argv.includes("--connected");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } });
const page = await context.newPage(), video = page.video(), errors = [], events = [];
const started = Date.now(), event = name => events.push({ name, seconds: (Date.now() - started) / 1000 });
let status = "failed";
let savedWorld = null;
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/generate-page", route => { errors.push("Unexpected generation request"); return route.abort(); });
await page.route("**/api/sketches/*/generate", route => { errors.push("Unexpected Sketch generation request"); return route.abort(); });
try {
  await page.goto(`${base}/sketch/world/ankh/geometry`);
  await page.getByTestId("drum-geometry").filter({ has: page.locator("canvas") }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="drum-geometry"]')?.getAttribute("data-ready") === "true");
  event("textured"); await page.waitForTimeout(1500);
  const slider = page.getByRole("slider", { name: "Camera travel", exact: true });
  for (let value = 0; value <= 70; value += 2) { await slider.fill(String(value)); await page.waitForTimeout(70); }
  event("second_view"); await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Teal roof", exact: true }).click();
  event("roof_edit"); await page.waitForTimeout(1300);
  await page.screenshot({ path: resolve(output, "second-view-edit.png") });
  for (let value = 70; value >= 0; value -= 2) { await slider.fill(String(value)); await page.waitForTimeout(70); }
  event("return"); await page.waitForTimeout(1200);
  await page.getByRole("slider", { name: "Image overlay", exact: true }).fill("45");
  await page.getByRole("button", { name: "Alignment points", exact: true }).click();
  event("alignment"); await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(output, "alignment.png") });
  await page.getByRole("slider", { name: "Image overlay", exact: true }).fill("0");
  await page.getByRole("button", { name: "Alignment points", exact: true }).click();
  event("end"); await page.waitForTimeout(1300);
  if (connected) {
    event("import_start");
    await page.getByRole("button", { name: "Save to world", exact: true }).click();
    await page.waitForURL("**/sketch/world?**");
    await page.getByTestId("place-viewport").getAttribute("data-ready");
    await page.waitForFunction(() => document.querySelector('[data-testid="place-viewport"]')?.getAttribute("data-ready") === "true");
    event("world_draft");
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world", exact: true }).waitFor();
    event("world_preview"); await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Revision 1 · Saved" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="place-viewport"]')?.getAttribute("data-ready") === "true");
    event("world_saved"); await page.waitForTimeout(1400);
    await page.reload();
    await page.getByRole("status").filter({ hasText: "Revision 1 · Saved" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="place-viewport"]')?.getAttribute("data-ready") === "true");
    await page.waitForTimeout(600); event("world_reloaded");
    await page.getByRole("button", { name: "The Mended Drum tavern", exact: true }).click();
    await page.getByRole("button", { name: "teal roof", exact: true }).waitFor();
    if (await page.getByRole("button", { name: "teal roof", exact: true }).getAttribute("aria-pressed") !== "true") throw new Error("Roof material did not survive reload");
    const source = new URL(page.url()).searchParams.get("source");
    const response = await page.request.get(`${base}/api/world/scene-context?source=${encodeURIComponent(source)}`);
    if (!response.ok()) throw new Error("Could not verify saved geometry");
    const saved = await response.json();
    savedWorld = { source, session_id: saved.session_id, place_id: saved.place_id, revision: saved.scene.revision, definition: saved.scene.definition };
    await page.screenshot({ path: resolve(output, "saved-world.png") });
    await page.waitForTimeout(2200); event("connected_end");
  }
  status = errors.length ? "failed" : "complete";
} finally {
  await context.close(); await video.saveAs(resolve(output, "uncut.webm")); await browser.close();
  await writeFile(resolve(output, "receipt.json"), JSON.stringify({ status, events, errors, saved_world: savedWorld, model_calls: 0, note: "Actual Three.js viewport; provisional roof/rear-depth fit; teal is an explicit mesh material edit, not automatic image-to-3D transfer" }, null, 2));
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify({ output, events }));
