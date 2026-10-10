/** Free, read-only close-up evidence. Uses normal editor selection and orbit controls.
 * Importing this module starts no browser, services, or generation requests.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const pilotReviewHash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const pilotReviewAllowsMethod = method => method === "GET" || method === "HEAD";

export function validatePilotReviewEnvironment(receipt, environment, manifest) {
  const directory = dirname(resolve(environment)), origin = new URL(receipt.origin);
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, "quality-pilot");
  assert.match(receipt.project, /^ofb-pilot-[a-f0-9]{12}$/); assert.equal(receipt.database, "quality_pilot");
  assert.equal(receipt.evidence_dir, directory); assert.equal(receipt.state, "running");
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1"); assert.ok(origin.port);
  assert.equal(origin.username, ""); assert.equal(origin.password, ""); assert.equal(origin.pathname, "/");
  assert.equal(origin.search, ""); assert.equal(origin.hash, "");
  for (const key of ["project", "origin", "database"]) assert.equal(manifest[key], receipt[key], "Private pilot context changed");
  assert.ok(safeId(manifest.world?.session_id) && safeId(manifest.world?.place_id), "Existing saved pilot ownership required");
  assert.equal(manifest.phases?.capture?.status, "complete", "Finish the physical capture before close-up review");
  return receipt;
}

export function derivePilotReviewTargets(definition) {
  assert.equal(definition?.version, 2); assert.ok(Array.isArray(definition.objects));
  const landmarks = definition.objects.filter(object => object.kind === "building" && object.label === "Copper Workshop");
  assert.equal(landmarks.length, 1, "Exactly one saved Copper Workshop is required");
  const building = landmarks[0], upper = building.structure?.floors?.[1];
  assert.ok(safeId(building.id) && safeId(upper?.id), "Saved upper floor is missing");
  const chair = definition.objects.filter(object => object.kind === "mesh" && object.mesh_role === "prop"
    && object.placement?.building_id === building.id && object.placement?.floor_id === upper.id && object.asset_id);
  assert.equal(chair.length, 1, "Exactly one generated prop on the saved workshop upper floor is required");
  const kiosk = definition.objects.filter(object => object.kind === "mesh" && object.mesh_role === "exterior"
    && object.label === "Garden Kiosk" && !object.placement && object.asset_id);
  assert.equal(kiosk.length, 1, "Exactly one saved exterior Garden Kiosk is required");
  const furniture = definition.objects.filter(object => object.id !== chair[0].id && object.placement?.building_id === building.id
    && object.placement?.floor_id === upper.id);
  for (const object of [chair[0], kiosk[0], ...furniture]) assert.ok(safeId(object.id) && typeof object.label === "string" && object.label.trim());
  return { building, upper, chair: chair[0], kiosk: kiosk[0], furniture };
}

async function privateJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file); await chmod(file, 0o600);
}
const sceneIdentity = scene => ({ id: scene.id, place_id: scene.place_id, revision: scene.revision, definition: scene.definition });

/** `definition` may describe an already-open proposal preview. This function never
 * opens or applies a proposal; its saved scene and position must remain unchanged.
 */
export async function reviewPilotFloor({ page, manifest, directory, definition }) {
  assert.ok(safeId(manifest.world?.session_id) && safeId(manifest.world?.place_id));
  const origin = new URL(manifest.origin), world = manifest.world;
  assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.protocol, "http:"); assert.ok(origin.port);
  assert.equal(new URL(page.url()).origin, origin.origin, "Review must use the existing isolated pilot page");
  const run = `floor-review-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const report = { version: 1, run, status: "needs_review", started_at: new Date().toISOString(),
    generation_submissions: 0, controls: "Editor Editing floor, object selection, Frame selected in 3D, and pointer orbit only",
    screenshots: [], blocked_requests: [], read_errors: [], checks: {} };
  const scenePath = `/api/world/${world.session_id}/places/${world.place_id}/scene`, walkPath = `/api/creator/worlds/${world.session_id}/walk`;
  const blockWrites = async route => {
    const request = route.request();
    if (pilotReviewAllowsMethod(request.method())) return route.continue();
    report.blocked_requests.push({ at: new Date().toISOString(), method: request.method(), path: new URL(request.url()).pathname });
    await route.abort("blockedbyclient");
  };
  const get = async path => {
    assert.ok(path === scenePath || path === walkPath);
    const response = await page.request.get(`${origin.origin}${path}`, { maxRedirects: 0 });
    assert.ok(response.ok(), `Owned read failed (${response.status()}) at ${path}`);
    return response.json();
  };
  const readScene = async () => { const value = await get(scenePath); return value.scene ?? value; };
  let before, beforeWalk;
  await page.route("**/*", blockWrites);
  try {
    // Switching out of a live Walk view can flush a position POST. Caller must
    // finish that capture and give us an editing view before read-only review.
    assert.equal(await page.locator('[data-testid="place-viewport"][data-mode="walk"]').count(), 0, "Finish walking before read-only review");
    before = await readScene(); beforeWalk = await get(walkPath);
    report.saved_scene = { id: before.id, revision: before.revision, sha256: pilotReviewHash(sceneIdentity(before)) };
    report.saved_position_sha256 = pilotReviewHash(beforeWalk);
    const reviewed = definition ?? before.definition, targets = derivePilotReviewTargets(reviewed);
    report.reviewed_definition_sha256 = pilotReviewHash(reviewed);
    report.review_source = definition ? "existing editor preview" : "saved scene";
    report.targets = { building_id: targets.building.id, floor_id: targets.upper.id,
      chair_id: targets.chair.id, chair_asset_id: targets.chair.asset_id, kiosk_id: targets.kiosk.id, kiosk_asset_id: targets.kiosk.asset_id,
      furniture_ids: targets.furniture.map(object => object.id) };
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = async () => {
      const viewport = page.locator('[data-testid="place-viewport"][data-mode="orbit"]').first();
      await expect(viewport).toBeVisible(); await expect(viewport).toHaveAttribute("data-ready", "true");
      await viewport.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
      return viewport;
    };
    const capture = async (label, object) => {
      const viewport = await ready(), path = join(directory, `${run}-${label}.png`);
      const observed = await viewport.evaluate(element => ({ mode: element.dataset.mode, camera: element.dataset.camera,
        yaw: element.dataset.yaw, selected: element.dataset.selected, ready: element.dataset.ready }));
      assert.equal(observed.selected, object.id, "The live viewport must frame the requested saved object");
      const floor_id = await page.getByRole("combobox", { name: "Editing floor", exact: true }).inputValue();
      await viewport.screenshot({ path }); await chmod(path, 0o600);
      report.screenshots.push({ label, file: path, object_id: object.id, floor_id: floor_id || null, observed });
      await privateJson(join(directory, `${run}-evidence.json`), report);
    };
    const frame = async object => {
      await button(`${object.label} ${object.kind}`).click();
      await button("Frame selected in 3D").click(); await ready();
    };
    const orbit = async () => {
      const viewport = await ready(), box = await viewport.boundingBox(); assert.ok(box);
      // Genuine pointer orbit, starting above the selected object to avoid a
      // selection click; no camera setters or DOM mutations.
      const x = box.x + box.width * 0.7, y = box.y + box.height * 0.25;
      await page.mouse.move(x, y); await page.mouse.down();
      try { await page.mouse.move(x - Math.min(100, box.width * 0.18), y + 30, { steps: 12 }); }
      finally { await page.mouse.up(); }
      await ready();
    };
    await button("3D").click();
    // Select the building first: an existing selected prop on this floor is
    // otherwise retained by the selector. Selecting the building afterward
    // would clear the floor and hide the cutaway.
    await button(`${targets.building.label} ${targets.building.kind}`).click();
    await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption(targets.upper.id);
    await button("Frame selected in 3D").click(); await capture("upper-cutaway", targets.building);
    await frame(targets.chair); await capture("chair-close", targets.chair);
    await orbit(); await capture("chair-side", targets.chair);
    for (const [index, object] of targets.furniture.entries()) {
      await frame(object); await capture(`furniture-${index + 1}`, object);
    }
    await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption("");
    await frame(targets.kiosk); await capture("kiosk-close", targets.kiosk);
    await orbit(); await capture("kiosk-side", targets.kiosk);
    assert.equal(report.blocked_requests.length, 0, "A browser write was attempted during read-only review");
    report.status = "ready_for_review";
    report.limitations = "Close-up evidence requires visual review; screenshots do not certify mesh topology, collision shape, or physical mobile performance.";
  } catch (error) {
    report.reason = error.message;
    const failure = join(directory, `${run}-failure.png`);
    await page.screenshot({ path: failure, fullPage: false }).then(() => chmod(failure, 0o600)).catch(() => {});
    report.failure_screenshot = failure;
  } finally {
    if (before) {
      try {
        const after = await readScene(), afterWalk = await get(walkPath);
        report.after_saved_scene = { id: after.id, revision: after.revision, sha256: pilotReviewHash(sceneIdentity(after)) };
        report.after_saved_position_sha256 = pilotReviewHash(afterWalk);
        report.checks.scene_unchanged = report.saved_scene.sha256 === report.after_saved_scene.sha256;
        report.checks.position_unchanged = report.saved_position_sha256 === report.after_saved_position_sha256;
        report.checks.no_browser_writes = report.blocked_requests.length === 0;
        if (!Object.values(report.checks).every(Boolean)) { report.status = "needs_review"; report.reason = "Saved scene/position changed or a write was attempted during review"; }
      } catch (error) { report.status = "needs_review"; report.read_errors.push(error.message); }
    }
    report.finished_at = new Date().toISOString();
    await privateJson(join(directory, `${run}-evidence.json`), report);
    await privateJson(join(directory, "floor-review-result.json"), report);
    await page.unroute("**/*", blockWrites);
  }
  return report;
}

async function privateFile(file) {
  const info = await lstat(file); assert.ok(info.isFile() && !(info.mode & 0o077), "Pilot ownership files must be private regular files (0600)");
  return JSON.parse(await readFile(file, "utf8"));
}
async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, video: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log("quality-pilot-review-floor.mjs --environment <private environment.json> [--video]\nFree saved-scene review only. No generation, preview, apply, or position writes."); return; }
  assert.ok(values.environment, "--environment is required");
  const environment = resolve(values.environment), directory = dirname(environment);
  const receipt = await privateFile(environment), manifest = await privateFile(join(directory, "pilot-manifest.json"));
  validatePilotReviewEnvironment(receipt, environment, manifest);
  const state = await privateFile(join(directory, "browser-state.json"));
  const lockPath = join(directory, ".quality-pilot.lock");
  // Match the existing phase/harness locks, without rewriting its manifest.
  const harnessLock = await open(join(directory, "harness.lock"), "wx", 0o600).catch(() => { throw new Error("Another pilot harness is active; finish it before free review"); });
  let ownsLock = false, browser, context, page, result;
  try {
    await mkdir(lockPath, { mode: 0o700 }).catch(() => { throw new Error("Another pilot phase is active; finish it before free review"); }); ownsLock = true;
    browser = await chromium.launch({ headless: true });
    const videoDir = join(directory, `floor-review-video-${Date.now()}`);
    if (values.video) await mkdir(videoDir, { mode: 0o700 });
    context = await browser.newContext({ baseURL: receipt.origin, storageState: state, serviceWorkers: "block",
      viewport: { width: 1280, height: 900 }, ...(values.video ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 900 } } } : {}) });
    page = await context.newPage(); page.setDefaultTimeout(30_000);
    const blocked = [];
    await page.route("**/*", async route => {
      if (pilotReviewAllowsMethod(route.request().method())) return route.continue();
      blocked.push({ method: route.request().method(), path: new URL(route.request().url()).pathname }); await route.abort("blockedbyclient");
    });
    await page.goto(`/sketch/world?${new URLSearchParams({ world: manifest.world.session_id, place: manifest.world.place_id, view: "orbit" })}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="place-viewport"][data-mode="orbit"]').first()).toHaveAttribute("data-ready", "true");
    result = await reviewPilotFloor({ page, manifest, directory });
    if (blocked.length) { result.status = "needs_review"; result.initial_navigation_blocked_requests = blocked; }
    await context.close(); context = null;
    if (values.video) { result.video = await page.video().path(); await chmod(result.video, 0o600); }
    await privateJson(join(directory, `${result.run}-evidence.json`), result); await privateJson(join(directory, "floor-review-result.json"), result);
    console.log(JSON.stringify({ status: result.status, report: join(directory, `${result.run}-evidence.json`), screenshots: result.screenshots.length, checks: result.checks }));
    if (result.status !== "ready_for_review") process.exitCode = 1;
  } finally {
    await context?.close(); await browser?.close(); if (ownsLock) await rm(lockPath, { recursive: true });
    await harnessLock.close(); await rm(join(directory, "harness.lock"));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
