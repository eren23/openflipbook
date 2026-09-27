import { chromium, expect as baseExpect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const expect = baseExpect.configure({ timeout: 120000 });
const output = resolve(process.argv[2] || "../../docs/research/assets/product-pilot-2026-09-11");
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:3003";
if (new URL(base).hostname !== "127.0.0.1") throw new Error("Pilot captures must use localhost");
await mkdir(output, { recursive: false });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: base, viewport: { width: 1920, height: 1080 }, recordVideo: { dir: output, size: { width: 1920, height: 1080 } } });
// A pointer marker is a recording aid only; it cannot intercept product events.
await context.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const pointer = document.createElement("div");
    pointer.setAttribute("aria-hidden", "true");
    pointer.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:12px;height:12px;border-radius:50%;background:#202725;border:2px solid white;box-shadow:0 1px 3px #0009;left:-100px;top:-100px;transform:translate(-50%,-50%)";
    document.body.append(pointer);
    document.addEventListener("pointermove", event => { pointer.style.left = `${event.clientX}px`; pointer.style.top = `${event.clientY}px`; });
    document.addEventListener("pointerdown", () => { pointer.style.boxShadow = "0 0 0 7px #379a8870"; });
    document.addEventListener("pointerup", () => { pointer.style.boxShadow = "0 1px 3px #0009"; });
  });
});
const page = await context.newPage();
page.setDefaultTimeout(120000);
const video = page.video(), events = [], errors = [];
const started = performance.now();
const event = name => { const entry = { name, seconds: (performance.now() - started) / 1000 }; events.push(entry); console.log(JSON.stringify(entry)); };
const pause = ms => page.waitForTimeout(ms);
let status = "failed", submissions = 0, result = null;
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/generate-page", route => { submissions++; return route.abort(); });
await page.route("**/api/animate", route => { submissions++; return route.abort(); });
const json = async path => { const response = await page.request.get(path); if (!response.ok()) throw new Error(`Read failed (${response.status()}): ${new URL(response.url()).pathname}`); return response.json(); };
const ready = async () => {
  await expect(page.getByTestId("place-viewport")).toHaveCount(2);
  for (const viewport of await page.getByTestId("place-viewport").all()) await expect(viewport).toHaveAttribute("data-ready", "true");
};
const click = async locator => {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Control has no visible bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  await locator.click();
};
const button = name => page.getByRole("button", { name, exact: true });
try {
  await page.goto("/n/9f58b1de-bba8-45e5-a0e5-cca31c679146");
  await click(button("Fork this world"));
  await page.waitForURL("**/play?continue=**");
  const session = new URL(page.url()).searchParams.get("continue");
  const graph = await json(`/api/sessions/${session}`);
  const source = graph.nodes.find(node => node.page_title === "The Mended Drum")?.id;
  if (!source) throw new Error("Demo street is missing from fork");
  await page.goto(`/sketch/world?source=${source}&view=split`);
  await ready();
  const contextUrl = `/api/world/scene-context?source=${source}`;
  const initial = await json(contextUrl);
  if (!initial.scene) throw new Error("Fork must already have a saved scene");
  const mapUrl = `/api/world/${session}/map`, initialMap = await json(mapUrl);
  const imageHash = async () => {
    const response = await page.request.get(initial.source_url);
    if (!response.ok()) throw new Error("Saved source image unavailable");
    return createHash("sha256").update(await response.body()).digest("hex");
  };
  const originalHash = await imageHash();
  await page.getByRole("combobox", { name: "Component type", exact: true }).selectOption("house");
  await pause(1200);
  event("pilot_start");
  await click(button("Draw footprint"));
  const planCanvas = page.getByRole("region", { name: "Live plan", exact: true }).locator("canvas");
  const box = await planCanvas.boundingBox();
  const definition = initial.scene.definition;
  const half = Math.max(definition.depth / 2 + 1, (definition.width / 2 + 1) * box.height / box.width);
  const point = (x, z) => ({ x: box.x + box.width / 2 + (x - definition.width / 2) * box.height / (2 * half), y: box.y + box.height / 2 + (z - definition.depth / 2) * box.height / (2 * half) });
  const from = point(27.5, 13), to = point(30.5, 16);
  await page.mouse.move(from.x, from.y, { steps: 16 }); await page.mouse.down();
  for (let i = 1; i <= 30; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / 30, from.y + (to.y - from.y) * i / 30); await pause(35); }
  await page.mouse.up(); await ready(); event("footprint_created");
  await page.getByRole("textbox", { name: "Object name", exact: true }).fill("Courtyard studio");
  await click(button("Frame selected in 3D")); await pause(900);
  await page.screenshot({ path: `${output}/footprint.png` });
  const height = page.getByRole("spinbutton", { name: "Object height", exact: true });
  await click(height); await height.fill("5.5"); await height.press("Tab");
  await ready(); event("height_changed");
  await click(button("Frame selected in 3D")); await pause(700);
  await page.screenshot({ path: `${output}/height.png` });
  const live3D = page.getByRole("region", { name: "Live 3D", exact: true });
  const view = live3D.getByTestId("place-viewport");
  const beforeCamera = await view.getAttribute("data-camera");
  const orbit = await live3D.locator("canvas").boundingBox();
  await page.mouse.move(orbit.x + orbit.width * .53, orbit.y + orbit.height * .45, { steps: 15 }); await page.mouse.down();
  for (let i = 1; i <= 50; i++) { await page.mouse.move(orbit.x + orbit.width * (.53 + .14 * i / 50), orbit.y + orbit.height * (.45 + .025 * i / 50)); await pause(30); }
  await page.mouse.up();
  await expect.poll(() => view.getAttribute("data-camera")).not.toBe(beforeCamera);
  event("orbited"); await pause(500); await page.screenshot({ path: `${output}/orbit.png` });
  const teal = button("teal roof");
  await click(teal);
  await ready(); await click(button("Frame selected in 3D")); event("material_changed"); await pause(900);
  expect(await json(mapUrl)).toEqual(initialMap);
  await click(button("Preview"));
  await expect(page.getByRole("region", { name: "World change preview" })).toContainText("Add Courtyard studio");
  await button("Apply to world").scrollIntoViewIfNeeded();
  event("review"); await pause(800);
  await click(button("Apply to world")); event("apply_requested");
  await expect(page.getByRole("status")).toHaveText(`Revision ${initial.scene.revision + 1} · Saved`); await ready();
  event("saved"); await pause(800); await page.reload(); await ready(); event("reload_ready");
  await click(button("Courtyard studio house")); await click(button("Frame selected in 3D"));
  await expect(height).toHaveValue("5.5"); await expect(teal).toHaveAttribute("aria-pressed", "true");
  await pause(1800); await page.screenshot({ path: `${output}/saved.png` }); event("pilot_end");
  const saved = await json(contextUrl), map = await json(mapUrl);
  const added = saved.scene.definition.objects.filter(o => !initial.scene.definition.objects.some(before => before.id === o.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ label: "Courtyard studio", height: 5.5, roof_material: "teal" });
  expect(added[0].width).toBeCloseTo(3, 1); expect(added[0].depth).toBeCloseTo(3, 1);
  const geo = map.entities.find(o => o.id === added[0].id);
  expect(geo).toMatchObject({ parent_id: saved.place_id, height: 5.5, footprint: { w: added[0].width, d: added[0].depth }, pos: { x: added[0].x - definition.width / 2, y: added[0].z - definition.depth / 2 } });
  expect(saved.scene.definition.objects.filter(o => o.id !== added[0].id)).toEqual(initial.scene.definition.objects);
  expect(map.entities.find(o => o.id === saved.place_id).pos).toEqual(initialMap.entities.find(o => o.id === saved.place_id).pos);
  expect(await imageHash()).toBe(originalHash); expect(submissions).toBe(0);
  result = { session_id: session, source, place_id: saved.place_id, scene_revision: saved.scene.revision, object: added[0], checks: { draft_map_unchanged: true, one_object_added: true, height_and_material_survive_reload: true, orbit_camera_changed: true, geometry_map_agree: true, existing_objects_unchanged: true, parent_position_unchanged: true, source_image_unchanged: true }, source_sha256: originalHash };
  await writeFile(`${output}/saved-scene.json`, JSON.stringify(saved.scene, null, 2));
  await writeFile(`${output}/saved-map.json`, JSON.stringify(map, null, 2));
  if (errors.length) throw new Error("Browser errors occurred");
  status = "complete";
} catch (error) {
  const message = String(error).replace(/cookie:[^\r\n]*/gi, "cookie: [redacted]");
  errors.push(message); console.error(message); process.exitCode = 1;
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
} finally {
  await context.close(); await video.saveAs(`${output}/uncut.webm`); await browser.close();
  await writeFile(`${output}/receipt.json`, JSON.stringify({ status, errors, events, generation_submissions: submissions, result, recording: "Actual isolated-browser product capture at 1920x1080. Pointer marker only; no replaced UI, mocked results, audio or model submissions. Raw recording includes setup and waits. Arcade polish and human acceptance are separate gates." }, null, 2));
}
