import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import JSZip from "jszip";
import { newComponent } from "../lib/place-scene";
import { MESH_MODEL, MESH_IMAGE_MODEL } from "../lib/mesh-asset";
import { fixtureGlb, fixtureTexturedGlb } from "./fixtures/mesh-glb";
import { fixtureShellGlb } from "./fixtures/mesh-shell";
import { fixtureMaterial } from "./fixtures/material-jpeg";
import { MATERIAL_MODEL, ILLUSTRATION_MODEL, ILLUSTRATION_EDIT_MODEL } from "../lib/asset-pipeline";
import sharp from "sharp";
import type { ViewCapture } from "../lib/place-view";
import { VIEW_PASSES } from "../lib/place-view";
import { BoxGeometry, Matrix3, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2 } from "three";

test.skip(process.env.E2E_PLACE_BUILD !== "1", "Isolated database and local fake planner; tests product wiring, not model quality");
test.describe.configure({ mode: "serial" });
let app: ChildProcess, client: MongoClient, origin: string, logs = "", pending: ServerResponse | undefined;
let appPort: number, appEnv: NodeJS.ProcessEnv;
let worker: ChildProcess;
const workers = new Set<ChildProcess>();
let originalRouteReference: string | undefined;
let submissions = 0;
let lastLayoutInput: Record<string, unknown>;
let meshEnabled = false, meshReady = false, failStorage = false, meshSubmissions = 0, meshDownloads = 0;
let meshReservation = 2;
let meshImageEnabled = false;
const meshInputs = new Map<number, { model: string; input_image_url?: string }>();
let materialEnabled = false, materialReady = false, materialSubmissions = 0;
let illustrationEnabled = false, illustrationReady = false, illustrationSubmissions = 0;
const illustrationParameters = { prompt_version: "loopback-fixture-not-model-output" };
const illustrationFixtures = new Map<number, { bytes: Buffer; model: string; inputs: { image_url: string; control_lora_image_url: string; mask_url?: string; image_size: { width: number; height: number } } }>();
const materialParameters = { image_size: { width: 1024, height: 1024 }, num_images: 1, output_format: "jpeg", enable_safety_checker: true, sync_mode: false, prompt_version: "base-color-tile-v1" };
const blobs = new Map<string, Buffer>();
const meshParameters = { enable_pbr: true, face_count: 40000, generate_type: "LowPoly", polygon_type: "triangle" };
const name = `ofb_e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
const backend = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/place-build/capabilities") { res.end(JSON.stringify({ enabled: true, reservation: 0.2, model: "e2e-fixture-planner", connection_context_version: 1, floor_target_version: 1 })); return; }
  if (req.url === "/illustration/capabilities") { res.end(JSON.stringify({ enabled: illustrationEnabled, reservation: 0.1, model: ILLUSTRATION_MODEL, parameters: illustrationParameters, reason: "Loopback illustration fixture disabled" })); return; }
  if (req.url === "/illustration/region-capabilities") { res.end(JSON.stringify({ enabled: illustrationEnabled, reservation: 0.1, model: ILLUSTRATION_EDIT_MODEL, parameters: illustrationParameters, reason: "Loopback masked fixture disabled" })); return; }
  if (req.url === "/illustration/submit" && req.method === "POST") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); expect([ILLUSTRATION_MODEL, ILLUSTRATION_EDIT_MODEL]).toContain(body.model); expect(body.parameters).toEqual(illustrationParameters);
    expect(!!body.inputs.mask_url).toBe(body.model === ILLUSTRATION_EDIT_MODEL);
    const source = Buffer.from(body.inputs.image_url.split(",")[1], "base64");
    const bytes = await sharp(source).modulate({ saturation: 0.5, brightness: body.inputs.mask_url ? 0.65 : 1 }).jpeg().toBuffer();
    illustrationFixtures.set(++illustrationSubmissions, { bytes, inputs: body.inputs, model: body.model });
    res.end(JSON.stringify({ request_id: `illustration_request_${illustrationSubmissions}`, model: body.model })); return;
  }
  if (req.url?.startsWith("/illustration/requests/")) { const url = new URL(req.url, "http://localhost"), index = Number(url.pathname.split("_").at(-1)); expect(url.searchParams.get("model") ?? ILLUSTRATION_MODEL).toBe(illustrationFixtures.get(index)!.model); res.end(JSON.stringify(illustrationReady ? { status: "ready", image: { url: `https://fal.media/ofb-worker-illustration-${index}.jpg` } } : { status: "running" })); return; }
  if (/^\/ofb-worker-illustration-\d+\.jpg$/.test(req.url ?? "")) { const index = Number(req.url!.match(/(\d+)\.jpg$/)![1]); res.setHeader("Content-Type", "image/jpeg"); res.end(illustrationFixtures.get(index)!.bytes); return; }
  if (req.url === "/material/capabilities") { res.end(JSON.stringify({ enabled: materialEnabled, reservation: 0.1, model: MATERIAL_MODEL, parameters: materialParameters })); return; }
  if (req.url === "/material/submit" && req.method === "POST") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); expect(body.model).toBe(MATERIAL_MODEL); expect(body.parameters).toEqual(materialParameters);
    materialSubmissions++; res.end(JSON.stringify({ request_id: `material_request_${materialSubmissions}`, model: MATERIAL_MODEL })); return;
  }
  if (req.url?.startsWith("/material/requests/")) { res.end(JSON.stringify(materialReady ? { status: "ready", image: { url: "https://fal.media/ofb-worker-material.jpg" } } : { status: "running" })); return; }
  if (req.url === "/fixture-material.jpg") { const bytes = fixtureMaterial(); res.setHeader("Content-Type", "image/jpeg"); res.end(bytes); return; }
  if (req.url === "/mesh/capabilities") { res.end(JSON.stringify({ enabled: meshEnabled, reason: "Fixture test has no mesh provider", model: MESH_MODEL, reservation: meshReservation, parameters: meshParameters })); return; }
  if (req.url === "/mesh/image-capabilities") { res.end(JSON.stringify({ enabled: meshImageEnabled, reason: "Loopback image mesh fixture disabled", model: MESH_IMAGE_MODEL, reservation: 2, parameters: meshParameters })); return; }
  if (req.url === "/mesh/submit" && req.method === "POST") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); expect(body.parameters).toEqual(meshParameters); expect([MESH_MODEL, MESH_IMAGE_MODEL]).toContain(body.model); expect(body.reservation).toBe(2);
    if (body.model === MESH_IMAGE_MODEL) expect(body.input_image_url).toMatch(/^data:image\/png;base64,/);
    meshInputs.set(++meshSubmissions, { model: body.model, input_image_url: body.input_image_url }); res.end(JSON.stringify({ request_id: `mesh_request_${meshSubmissions}`, model: body.model })); return;
  }
  if (req.url?.startsWith("/mesh/requests/")) { const url = new URL(req.url, "http://localhost"), index = Number(url.pathname.split("_").at(-1)); expect(url.searchParams.get("model") ?? MESH_MODEL).toBe(meshInputs.get(index)!.model); res.end(JSON.stringify(meshReady ? { status: "ready", model_glb: { url: "https://fal.media/ofb-worker-fixture.glb" }, seed: 12 } : { status: "running" })); return; }
  if (req.url === "/fixture.glb") { meshDownloads++; const bytes = fixtureGlb(); res.setHeader("Content-Type", "model/gltf-binary"); res.setHeader("Content-Length", bytes.length); res.end(bytes); return; }
  const path = new URL(req.url!, "http://127.0.0.1").pathname;
  if (path.startsWith("/fixture-store/")) {
    const key = decodeURIComponent(path.slice("/fixture-store/".length));
    if (req.method === "PUT") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (failStorage) { res.statusCode = 503; res.setHeader("Content-Type", "application/xml"); res.end("<Error><Code>ServiceUnavailable</Code></Error>"); return; }
      blobs.set(key, Buffer.concat(chunks)); res.setHeader("ETag", '"fixture-etag"'); res.end(); return;
    }
    const bytes = blobs.get(key);
    if (bytes) { res.setHeader("Content-Type", "model/gltf-binary"); res.setHeader("Content-Length", bytes.length); res.end(bytes); return; }
  }
  if (req.url === "/place-build/plan" && req.method === "POST") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    lastLayoutInput = JSON.parse(Buffer.concat(chunks).toString());
    submissions++; pending = res; return;
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: "No external generation in this test" }));
});
function finishPlan(withMaterials = false, withMeshes = false, withGround = false) {
  const first = { ...newComponent("building", 10, 14), label: "North workshop", height: 7.8 };
  first.structure!.floors.push({ id: "upper", label: "Upper workshop" });
  const second = { ...newComponent("building", 28, 14), label: "South workshop" };
  const volumes = withMeshes ? [
    { ...newComponent("volume", 28, 30), label: "Stone monument", width: 4, depth: 8, height: 6 },
    { ...newComponent("volume", 1.8, 1.5), label: "Room furnishing", width: 0.7, depth: 0.7, height: 0.8, placement: { building_id: first.id, floor_id: "upper" } },
  ] : [];
  const meshes = volumes.map((o, i) => ({ id: `mesh${i}`, prompt: `TEST FIXTURE - ${o.label}`, role: i === 0 ? "exterior" : "prop", targets: [{ object_id: o.id }] }));
  const path = newComponent("path", 20, 20);
  const materials = ["wall", "roof"].map(surface => ({ id: surface, prompt: `TEST FIXTURE - shared ${surface} texture`, targets: [first, second].map(o => ({ object_id: o.id as string | null, surface, tile_metres: 2, rotation: 0, roughness: 0.85 })) }));
  if (withGround) materials[0]!.targets.push(...[path.id, null].map(object_id => ({ object_id, surface: "floor", tile_metres: 3, rotation: 0, roughness: 0.85 })));
  pending!.end(JSON.stringify({ status: "ready", model: "e2e-fixture-planner", request_id: `fixture_${submissions}`, result: { objects: [first, second, ...volumes, ...(withGround ? [path] : [])], ...(withMaterials ? { materials } : {}), ...(withMeshes ? { meshes } : {}) } })); pending = undefined;
}
async function startApp() {
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: process.cwd(), env: appEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", data => { logs = (logs + data).slice(-10_000); }); app.stderr?.on("data", data => { logs = (logs + data).slice(-10_000); });
  await expect.poll(async () => {
    if (app.exitCode !== null) throw new Error(`Isolated Next server exited: ${logs}`);
    try { return (await fetch(`${origin}/sketch/world`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, { timeout: 150_000, intervals: [1000] }).toBe(true);
}
async function stopApp() {
  if (app && app.exitCode === null) { const exited = once(app, "exit"); app.kill("SIGTERM"); await exited; }
}
async function startWorker() {
  let output = "";
  const child = spawn(process.execPath, ["--import", "./e2e/fixtures/mesh-fetch.mjs", "--import", "tsx", "scripts/place-build-worker.ts"], { cwd: process.cwd(), env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  workers.add(child);
  child.stdout?.on("data", data => { output = (output + data).slice(-5000); }); child.stderr?.on("data", data => { output = (output + data).slice(-5000); });
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(`Isolated worker exited: ${output}`);
      return output.includes("Layout worker ready");
    }, { timeout: 30_000, intervals: [250] }).toBe(true);
  } catch (error) {
    throw new Error(`Worker readiness failed (exit=${child.exitCode}, signal=${child.signalCode}): ${output}`, { cause: error });
  }
  return child;
}
async function stopWorker(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(signal); await exited; }
  workers.delete(child);
}
async function importThroughLibrary(page: Page, bytes: Buffer) {
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: "Import World", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import World", exact: true });
  const inspection = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/creator/imports");
  await dialog.getByLabel("World archive").setInputFiles({ name: "world-roundtrip.zip", mimeType: "application/zip", buffer: bytes });
  const response = await inspection; expect(response.status(), await response.text()).toBe(200);
  const preview = await response.json();
  const application = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/creator/imports/${preview.request_id}`);
  await dialog.getByRole("button", { name: "Import as private world", exact: true }).click();
  const applied = await application; expect(applied.status(), await applied.text()).toBe(200);
  await expect(dialog.getByRole("status")).toHaveText("Private world saved");
  return preview.session_id as string;
}
test.beforeAll(async () => {
  test.setTimeout(180_000); process.loadEnvFile(".env.local");
  originalRouteReference = (await readFile("next-env.d.ts", "utf8")).split("\n").find(line => line.startsWith("/// <reference path="));
  client = new MongoClient(process.env.MONGODB_URI!); await client.connect();
  if ((await client.db().admin().listDatabases({ nameOnly: true })).databases.some(d => d.name === name)) throw new Error("Test database already exists");
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const port = (backend.address() as { port: number }).port;
  const free = createServer(); free.listen(0, "127.0.0.1"); await once(free, "listening"); appPort = (free.address() as { port: number }).port; await new Promise<void>(resolve => free.close(() => resolve()));
  origin = `http://127.0.0.1:${appPort}`;
  appEnv = { ...process.env, MONGODB_DB: name, MODAL_API_URL: `http://127.0.0.1:${port}`, SHARED_TOKEN: "fixture-only", NEXT_PUBLIC_WORLD_SCENES: "1",
    R2_ENDPOINT: `http://127.0.0.1:${port}`, R2_BUCKET: "fixture-store", R2_ACCESS_KEY_ID: "fixture-only", R2_SECRET_ACCESS_KEY: "fixture-only", R2_PUBLIC_BASE_URL: `http://127.0.0.1:${port}/fixture-store`, E2E_MESH_DOWNLOAD_ORIGIN: `http://127.0.0.1:${port}`,
    NEXT_DIST_DIR: "test-results/place-build-next", NEXT_TSCONFIG_PATH: "tsconfig.e2e.json", NEXT_TELEMETRY_DISABLED: "1", MAX_DAILY_SPEND: "40", MAX_SESSION_SPEND: "10", PLACE_BUILD_DAILY_CAP_USD: "10", MESH_DAILY_CAP_USD: "30" };
  worker = await startWorker(); await startApp();
});

for (const width of [1280, 390]) test(`authored stair placement, traversal and persistence at ${width}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const before = [submissions, meshSubmissions, materialSubmissions, illustrationSubmissions];
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
  const viewport = page.getByTestId("place-viewport"), ready = () => expect(viewport).toHaveAttribute("data-ready", "true"); await ready();
  const camera = async () => (await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const walk = async (key: string, axis: number, target: number, less: boolean) => {
    await page.keyboard.down(key);
    try { await expect.poll(async () => { const value = (await camera())[axis]!; return less ? value < target : value > target; }, { intervals: [30] }).toBe(true); }
    finally { await page.keyboard.up(key); }
  };
  const save = async (revision: number) => {
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready();
  };
  await page.getByLabel("Place width", { exact: true }).fill("20"); await page.getByLabel("Place depth", { exact: true }).fill("20");
  await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("10"); await page.getByLabel("Entrance z", { exact: true }).fill("16");
  await page.getByRole("combobox", { name: "Component type" }).selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("2");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await save(1);
  const sid = new URL(page.url()).searchParams.get("world")!, db = client.db(name), read = () => db.collection("place_scenes").findOne({ session_id: sid });
  const original = (await read())!; expect(original.definition.objects[0].structure.stair).toBeUndefined();
  const views = page.getByRole("region", { name: "Saved camera views", exact: true });
  await views.getByLabel("View name", { exact: true }).fill("Before moving stairs");
  await views.getByRole("button", { name: "Save camera view", exact: true }).click();
  await expect(views.getByRole("status").filter({ hasText: /^Current geometry/ })).toBeVisible();
  await page.getByRole("button", { name: "Building building", exact: true }).click();
  await page.getByLabel("Stair centre x", { exact: true }).fill("0"); await page.getByLabel("Stair centre z", { exact: true }).fill("1");
  await page.getByLabel("Stair climbing direction", { exact: true }).selectOption("east");
  await page.getByLabel("Stair centre x", { exact: true }).fill("50");
  await expect(page.getByRole("alert").filter({ hasText: /landing clearance/ })).toBeVisible();
  await expect(page.getByLabel("Stair centre x", { exact: true })).toHaveValue("0");
  await page.getByLabel("Stair climbing direction", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/stair-controls-${width}.png` }); await save(2);
  const changed = (await read())!, building = changed.definition.objects[0], stair = building.structure.stair;
  expect(stair).toMatchObject({ x: 0, z: 1, direction: "east" }); expect(stair.id).toBeTruthy();
  expect({ ...building.structure, stair: undefined }).toEqual({ ...original.definition.objects[0].structure, stair: undefined });
  expect(building.id).toBe(original.definition.objects[0].id);
  await expect(views.getByRole("status").filter({ hasText: /^Historical geometry/ })).toBeVisible();
  await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(350);
  await page.screenshot({ path: `test-results/stair-exterior-${width}.png` });
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  await walk("w", 2, 13, true); await walk("a", 0, 7.05, true); await walk("w", 2, 11.05, true);
  // Align the walking capsule with the centre of the 1.2m flight, using input.
  for (let i = 0; i < 40; i++) { const z = (await camera())[2]!; if (Math.abs(z - 11) < 0.12) break; await page.keyboard.press(z > 11 ? "w" : "s", { delay: 5 }); await page.waitForTimeout(100); }
  expect(Math.abs((await camera())[2]! - 11)).toBeLessThan(0.15);
  await walk("d", 0, 12.75, false); expect((await camera())[1]).toBeGreaterThan(4.7);
  await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space?.floor_id).toBe(building.structure.floors[1].id);
  await page.screenshot({ path: `test-results/stair-upstairs-${width}.png` });
  const upstairsExport = await page.request.get(`${origin}/api/export/session/${sid}`); expect(upstairsExport.status()).toBe(200);
  const upstairsBytes = await upstairsExport.body();
  await page.reload(); await ready(); await expect(viewport).toHaveAttribute("data-pose-restore", "restored"); expect((await camera())[1]).toBeGreaterThan(4.7);
  await viewport.scrollIntoViewIfNeeded(); await walk("a", 0, 7.1, true); await expect.poll(async () => (await camera())[1]).toBeLessThan(1.7);
  await walk("s", 2, 13, false); await walk("d", 0, 9.95, false); await walk("s", 2, 15.4, false);
  await expect.poll(() => viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data; let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i]!); max = Math.max(max, data[i]!); } return max - min;
  })).toBeGreaterThan(25);
  await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  const exported = await page.request.get(`${origin}/api/export/session/${sid}`); expect(exported.status()).toBe(200);
  const zip = await JSZip.loadAsync(await exported.body()), scenes = JSON.parse(await zip.file("place-scenes.json")!.async("string"));
  expect(scenes.find((s: { revision: number }) => s.revision === 2).definition).toEqual(changed.definition);
  const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${sid}/fork` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json();
  await expect(page).toHaveURL(new RegExp(`world=${fork.session_id}`)); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition).toEqual(changed.definition);
  const restoredSid = await importThroughLibrary(page, upstairsBytes);
  const restored = (await db.collection("place_scenes").findOne({ session_id: restoredSid }))!;
  expect(restored.definition).toEqual(changed.definition);
  expect(await db.collection("place_scene_versions").countDocuments({ session_id: restoredSid })).toBe(2);
  await stopApp(); await startApp();
  await page.goto(`${origin}/sketch/world?world=${restoredSid}&place=${restored.place_id}&view=walk`); await ready();
  await expect(viewport).toHaveAttribute("data-pose-restore", "restored"); expect((await camera())[1]).toBeGreaterThan(4.7);
  await viewport.scrollIntoViewIfNeeded();
  await viewport.screenshot({ path: `test-results/world-import-stair-${width}.png` });
  await walk("a", 0, 7.1, true); await expect.poll(async () => (await camera())[1]).toBeLessThan(1.7);
  await walk("s", 2, 13, false); await walk("d", 0, 9.95, false); await walk("s", 2, 15.4, false);
  expect([submissions, meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});

for (const width of [1280, 390]) test(`compound building outline, recessed entry and persistence at ${width}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const before = [submissions, meshSubmissions, materialSubmissions, illustrationSubmissions];
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
  const viewport = page.getByTestId("place-viewport"), ready = () => expect(viewport).toHaveAttribute("data-ready", "true"); await ready();
  const camera = async () => (await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const walk = async (key: string, axis: number, target: number, less: boolean) => {
    await page.keyboard.down(key);
    try { await expect.poll(async () => { const value = (await camera())[axis]!; return less ? value < target : value > target; }, { intervals: [30] }).toBe(true); }
    finally { await page.keyboard.up(key); }
  };
  const save = async (revision: number) => {
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready();
  };
  await page.getByLabel("Place width", { exact: true }).fill("20"); await page.getByLabel("Place depth", { exact: true }).fill("20");
  await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("16"); await page.getByLabel("Entrance z", { exact: true }).fill("10");
  await page.getByRole("combobox", { name: "Component type" }).selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("2");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await save(1);
  const sid = new URL(page.url()).searchParams.get("world")!, db = client.db(name), read = () => db.collection("place_scenes").findOne({ session_id: sid });
  const original = (await read())!;
  const views = page.getByRole("region", { name: "Saved camera views", exact: true });
  await views.getByLabel("View name", { exact: true }).fill("Before footprint edit"); await views.getByRole("button", { name: "Save camera view", exact: true }).click();
  await expect(views.getByRole("status").filter({ hasText: /^Current geometry/ })).toBeVisible();
  await page.getByRole("button", { name: "Building building", exact: true }).click();
  await page.getByRole("button", { name: "Edit outline", exact: true }).click();
  await page.getByLabel("Footprint corner 1 x", { exact: true }).fill("-3"); await page.getByRole("button", { name: "Apply outline", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /right angles/ })).toBeVisible();
  await expect(page.getByLabel("Footprint corner 1 x", { exact: true })).toHaveValue("-3");
  await page.getByLabel("Footprint corner 1 x", { exact: true }).fill("-4");
  await page.getByRole("button", { name: "Add footprint recess", exact: true }).click();
  await page.getByRole("img", { name: "Draft building footprint", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/compound-outline-${width}.png` });
  await page.getByRole("button", { name: "Apply outline", exact: true }).click();
  await page.getByLabel("Doorway wall", { exact: true }).selectOption({ label: "east / wall 4" });
  await page.getByLabel("Room layout floor", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create room layout", exact: true }).click();
  await page.getByLabel("Room split direction", { exact: true }).selectOption("z");
  await page.getByRole("button", { name: "Split room", exact: true }).click();
  await expect(page.getByLabel("Selected partition", { exact: true })).toBeVisible();
  await page.getByLabel("Room name", { exact: true }).fill("South loft");
  await page.getByRole("combobox", { name: "Component type" }).selectOption("bench");
  await page.getByRole("button", { name: "Add object", exact: true }).click();
  await save(2);
  const changed = (await read())!, building = changed.definition.objects[0];
  expect(building.structure.footprint).toHaveLength(8); expect(building.structure.door.wall_id).toBe(building.structure.footprint[3].id);
  expect(building.id).toBe(original.definition.objects[0].id); expect(building.structure.floors.map((f: { id: string }) => f.id)).toEqual(original.definition.objects[0].structure.floors.map((f: { id: string }) => f.id));
  expect(building.structure.floors[1].layout.type).toBe("split");
  expect(changed.definition.objects[1].placement).toEqual({ building_id: building.id, floor_id: building.structure.floors[1].id });
  await expect(views.getByRole("status").filter({ hasText: /^Historical geometry/ })).toBeVisible();
  await page.screenshot({ path: `test-results/compound-plan-${width}.png` });
  await page.getByRole("button", { name: "Building building", exact: true }).click();
  await page.getByLabel("Editing floor", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(350);
  await page.screenshot({ path: `test-results/compound-exterior-${width}.png` });
  await page.getByRole("button", { name: "Camera path", exact: true }).click();
  await page.getByLabel("Azimuth value", { exact: true }).fill("90"); await page.getByLabel("Elevation value", { exact: true }).fill("20"); await page.getByLabel("Distance value", { exact: true }).fill("18");
  await page.getByRole("button", { name: "Camera path", exact: true }).click(); await viewport.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/compound-courtyard-${width}.png` });
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  await walk("a", 0, 13, true);
  await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space).toBeNull();
  await walk("a", 0, 10.2, true);
  await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space?.building_id).toBe(building.id);
  await walk("s", 2, 12.4, false); await walk("a", 0, 7.1, true);
  for (let i = 0; i < 40; i++) { const x = (await camera())[0]!; if (Math.abs(x - 7.05) < 0.12) break; await page.keyboard.press(x > 7.05 ? "a" : "d", { delay: 5 }); await page.waitForTimeout(100); }
  expect(Math.abs((await camera())[0]! - 7.05)).toBeLessThan(0.15);
  await walk("w", 2, 6.3, true); expect((await camera())[1]).toBeGreaterThan(4.7);
  await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space?.floor_id).toBe(building.structure.floors[1].id);
  await page.keyboard.down("ArrowLeft");
  try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw")), { intervals: [30] }).toBeGreaterThan(3.12); } finally { await page.keyboard.up("ArrowLeft"); }
  await page.screenshot({ path: `test-results/compound-upstairs-${width}.png` });
  const upperPixels = await viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data, values = Array.from(data).filter((_, i) => i % 4 === 0); return Math.max(...values) - Math.min(...values);
  });
  expect(upperPixels).toBeGreaterThan(25);
  await page.keyboard.down("ArrowRight");
  try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw")), { intervals: [30] }).toBeLessThan(0.02); } finally { await page.keyboard.up("ArrowRight"); }
  await page.reload(); await ready(); await expect(viewport).toHaveAttribute("data-pose-restore", "restored"); expect((await camera())[1]).toBeGreaterThan(4.7);
  await viewport.scrollIntoViewIfNeeded(); await walk("s", 2, 12.4, false); await expect.poll(async () => (await camera())[1]).toBeLessThan(1.7);
  await walk("d", 0, 9.95, false); await walk("w", 2, 10.05, true);
  await walk("d", 0, 15.5, false);
  await expect.poll(() => viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data; let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i]!); max = Math.max(max, data[i]!); } return max - min;
  })).toBeGreaterThan(25);
  await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  const exported = await page.request.get(`${origin}/api/export/session/${sid}`); expect(exported.status()).toBe(200);
  const zip = await JSZip.loadAsync(await exported.body()), scenes = JSON.parse(await zip.file("place-scenes.json")!.async("string"));
  expect(scenes.find((s: { revision: number }) => s.revision === 2).definition).toEqual(changed.definition);
  const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${sid}/fork` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json();
  await expect(page).toHaveURL(new RegExp(`world=${fork.session_id}`)); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition).toEqual(changed.definition);
  expect([submissions, meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});

for (const width of [1280, 390]) test.describe(`mesh shell at ${width}`, () => {
test.use({ hasTouch: width === 390 });
test(`mesh shell conversion rejects solids and preserves traversal at ${width}`, async ({ page }) => {
  test.setTimeout(180_000);
  meshEnabled = meshImageEnabled = materialEnabled = illustrationEnabled = false; failStorage = false;
  const before = [submissions, meshSubmissions, materialSubmissions, illustrationSubmissions], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); await stopWorker(worker);
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
    const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
    const saved = async (revision: number) => { await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready(); };
    const preview = () => page.getByRole("button", { name: "Preview", exact: true }).click();
    const apply = () => page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await page.getByLabel("Place name", { exact: true }).fill(`Mesh shell fixture ${width}`);
    await page.getByLabel("Place width", { exact: true }).fill("20"); await page.getByLabel("Place depth", { exact: true }).fill("20");
    await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("10"); await page.getByLabel("Entrance z", { exact: true }).fill("18");
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await preview(); await apply(); await saved(1);
    const sid = new URL(page.url()).searchParams.get("world")!, db = client.db(name), read = () => db.collection("place_scenes").findOne({ session_id: sid });
    const source = newComponent("building", 10, 10); source.height = 7.8; source.structure!.windows = []; source.structure!.floors.push({ id: "upper", label: "Upper" });
    const closed = fixtureShellGlb(source, true), open = fixtureShellGlb(source);
    const panel = page.getByRole("region", { name: "AI 3D generation" }); await panel.getByRole("button", { name: "Import", exact: true }).click();
    const upload = async (name: string, buffer: Buffer) => { await panel.getByLabel("GLB file").setInputFiles({ name, mimeType: "model/gltf-binary", buffer }); await panel.getByRole("button", { name: "Import GLB", exact: true }).click(); await expect(panel.getByRole("status").filter({ hasText: "GLB validated and saved" })).toBeVisible(); };
    await upload("Closed shell fixture.glb", closed); await panel.getByRole("button", { name: "Place in scene", exact: true }).click();
    await page.getByLabel("Object name", { exact: true }).fill("Mesh workshop"); await page.getByLabel("Object x", { exact: true }).fill("10"); await page.getByLabel("Object z", { exact: true }).fill("10"); await page.getByLabel("Object width", { exact: true }).fill("8");
    await preview(); await apply(); await saved(2); const original = (await read())!.definition.objects[0];
    const proposalCount = await db.collection("world_edit_proposals").countDocuments({ session_id: sid });
    await page.getByRole("button", { name: "Add structural shell", exact: true }).click(); await preview();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Mesh blocks shell free space"); await expect(page.getByRole("button", { name: "Walk", exact: true })).toBeDisabled();
    expect((await read())!.definition.objects[0]).toEqual(original); expect((await read())!.revision).toBe(2);
    expect(await db.collection("world_edit_proposals").countDocuments({ session_id: sid })).toBe(proposalCount);
    await page.screenshot({ path: `test-results/mesh-shell-rejected-${width}.png` });
    await upload("Open shell fixture.glb", open);
    await panel.getByRole("list", { name: "Saved meshes" }).getByRole("listitem").filter({ hasText: "Open shell fixture.glb" }).getByRole("button", { name: "Replace selected mesh", exact: true }).click();
    await preview(); await expect(page.getByRole("region", { name: "World change preview" })).toContainText("mesh shell validated"); await apply(); await saved(3);
    const converted = (await read())!.definition.objects[0];
    expect(converted).toMatchObject({ kind: "building", id: original.id, entity_id: original.entity_id, x: 10, z: 10, width: 8, depth: 9 }); expect(converted.height).toBeCloseTo(original.height, 6); expect(converted.height).toBeCloseTo(7.8, 6); expect(converted.asset_id).not.toBe(original.asset_id);
    expect(converted.structure.floors).toHaveLength(2);
    await page.getByRole("button", { name: "3D", exact: true }).click(); await ready();
    const viewport = page.getByTestId("place-viewport"); await viewport.scrollIntoViewIfNeeded();
    const colored = () => viewport.locator("canvas").evaluate(el => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128); const pixels = ctx.getImageData(0, 0, 128, 128).data; let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > pixels[i + 1]! * 1.2 && pixels[i + 2]! > pixels[i + 1]! * 1.2) count++; return count;
    });
    await expect.poll(colored).toBeGreaterThan(30); await viewport.screenshot({ path: `test-results/mesh-shell-exterior-${width}.png` });
    const views = page.getByRole("region", { name: "Saved camera views", exact: true }); await views.getByRole("button", { name: "Save camera view", exact: true }).click(); await expect(views.getByRole("status").filter({ hasText: "Current geometry" })).toBeVisible();
    const captured = (await db.collection("place_views").findOne({ session_id: sid }))!;
    expect(captured.assets).toContainEqual({ kind: "mesh", id: converted.asset_id, sha256: (await db.collection("mesh_assets").findOne({ session_id: sid, id: converted.asset_id }))!.sha256 });
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
    const camera = async () => (await viewport.getAttribute("data-camera"))!.split(",").map(Number);
    const walk = async (key: string, axis: number, target: number, less = true) => {
      await page.keyboard.down(key); try { await expect.poll(async () => less ? (await camera())[axis]! < target : (await camera())[axis]! > target, { intervals: [30] }).toBe(true); } finally { await page.keyboard.up(key); }
    };
    if (width === 390) {
      const touch = await page.context().newCDPSession(page);
      const hold = async (label: string, until: () => Promise<void>, cancel = false) => {
        const button = page.getByRole("button", { name: label, exact: true }); await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
        try { await until(); } finally { await touch.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] }); }
      };
      try {
        await hold("Walk forward", async () => { await expect.poll(async () => (await camera())[2]!, { intervals: [30] }).toBeLessThan(12.3); });
        const stopped = await camera(); await page.waitForTimeout(300); expect((await camera())[2]).toBeCloseTo(stopped[2]!, 2);
        await hold("Strafe right", async () => { await expect.poll(async () => (await camera())[0]!, { intervals: [30] }).toBeGreaterThan(stopped[0]! + 0.3); }, true);
        const cancelled = await camera(); await page.waitForTimeout(300); expect((await camera())[0]).toBeCloseTo(cancelled[0]!, 2);
      } finally { await touch.detach(); }
    } else await walk("w", 2, 12.3);
    await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space?.building_id).toBe(converted.id);
    await viewport.screenshot({ path: `test-results/mesh-shell-interior-${width}.png` }); await walk("a", 0, 7.15);
    for (let i = 0; i < 40; i++) { const x = (await camera())[0]!; if (Math.abs(x - 7.05) < 0.12) break; await page.keyboard.press(x > 7.05 ? "a" : "d", { delay: 5 }); await page.waitForTimeout(100); }
    expect(Math.abs((await camera())[0]! - 7.05)).toBeLessThan(0.15); await walk("w", 2, 6.3); expect((await camera())[1]).toBeGreaterThan(4.7);
    await page.keyboard.press("w", { delay: 350 }); expect((await camera())[2]).toBeGreaterThan(6.0); expect((await camera())[1]).toBeGreaterThan(4.7);
    await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space?.floor_id).toBe(converted.structure.floors[1].id);
    await page.keyboard.down("ArrowLeft"); try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw")), { intervals: [30] }).toBeGreaterThan(3.12); } finally { await page.keyboard.up("ArrowLeft"); }
    await expect.poll(colored).toBeGreaterThan(30); await viewport.screenshot({ path: `test-results/mesh-shell-upstairs-${width}.png` });
    await page.keyboard.down("ArrowRight"); try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw")), { intervals: [30] }).toBeLessThan(0.02); } finally { await page.keyboard.up("ArrowRight"); }
    const savedYaw = Number(await viewport.getAttribute("data-yaw")), savedCamera = await camera();
    await expect.poll(async () => {
      const pose = (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose;
      return pose ? Math.abs(pose.yaw - savedYaw) : Infinity;
    }).toBeLessThan(0.002);
    await expect(page.getByRole("status").filter({ hasText: /^Position saved$/ })).toBeVisible();
    await page.reload(); await ready(); await viewport.scrollIntoViewIfNeeded(); expect((await camera())[1]).toBeGreaterThan(4.7);
    expect(Number(await viewport.getAttribute("data-yaw"))).toBeCloseTo(savedYaw, 2);
    expect((await camera())[0]).toBeCloseTo(savedCamera[0]!, 2); expect((await camera())[2]).toBeCloseTo(savedCamera[2]!, 2);
    await walk("s", 2, 12.3, false); await expect.poll(async () => (await camera())[1]).toBeLessThan(1.7); await walk("d", 0, 9.98, false); await walk("s", 2, 15.3, false);
    await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.space).toBeNull();
    await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(); await page.getByRole("button", { name: "Mesh workshop building", exact: true }).click();
    await page.getByLabel("Doorway wall", { exact: true }).selectOption("east"); await preview(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Mesh blocks shell free space"); expect((await read())!.definition.objects[0]).toEqual(converted);
    await page.getByRole("button", { name: "Undo draft edit", exact: true }).click(); await saved(3);
    const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body()), assets = JSON.parse(await zip.file("mesh-assets.json")!.async("string"));
    expect(assets).toHaveLength(2); const mesh = assets.find((a: { id: string }) => a.id === converted.asset_id); expect(await zip.file(mesh.file)!.async("nodebuffer")).toEqual(open);
    const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`); await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await response).json(); await saved(3);
    expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition.objects[0]).toEqual(converted);
    expect([submissions, meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual(before); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { worker = await startWorker(); }
});
});

for (const width of [1280, 390]) test(`import replace duplicate mesh lifecycle at ${width}`, async ({ page, browser }) => {
  test.setTimeout(180_000);
  meshEnabled = meshImageEnabled = materialEnabled = illustrationEnabled = false; failStorage = false;
  const before = [submissions, meshSubmissions, materialSubmissions, illustrationSubmissions], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await stopWorker(worker);
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
    const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
    const saved = async (revision: number) => {
      await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready();
    };
    await page.getByLabel("Place name", { exact: true }).fill(`Mesh import workflow ${width}`);
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page).toHaveURL(/world=session_/); await saved(1);
    const sid = new URL(page.url()).searchParams.get("world")!, db = client.db(name), endpoint = `${origin}/api/world/${sid}/meshes`;
    const panel = page.getByRole("region", { name: "AI 3D generation" }); await panel.getByRole("button", { name: "Import", exact: true }).click();
    await panel.getByLabel("GLB file").setInputFiles({ name: "Invalid.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("Invalid GLB") });
    await panel.getByRole("button", { name: "Import GLB", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("GLB");
    expect(await db.collection("mesh_assets").countDocuments({ session_id: sid })).toBe(0);
    const png = await sharp(fixtureMaterial()).png().toBuffer(), first = fixtureTexturedGlb(png), second = fixtureTexturedGlb(png, json => { json.nodes[0]!.scale = [2, 0.5, 1]; });
    let lost = true; const imports: Buffer[] = [];
    await page.route(`**/api/world/${sid}/meshes/import`, async route => {
      imports.push(route.request().postDataBuffer()!); const response = await route.fetch();
      if (lost && response.ok()) { lost = false; await route.abort("failed"); } else await route.fulfill({ response });
    });
    await panel.getByLabel("GLB file").setInputFiles({ name: "Textured fixture.glb", mimeType: "model/gltf-binary", buffer: first });
    await panel.getByRole("button", { name: "Import GLB", exact: true }).click(); await panel.getByRole("button", { name: "Retry GLB import", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "GLB validated and saved" })).toBeVisible();
    expect(imports).toHaveLength(2); expect(imports[1]).toEqual(imports[0]);
    const originalAsset = (await db.collection("mesh_assets").findOne({ session_id: sid }))!;
    expect(originalAsset).not.toHaveProperty("request_id"); expect(originalAsset.imported).toMatchObject({ kind: "imported_mesh", filename: "Textured fixture.glb" });
    expect(blobs.get(originalAsset.key)).toEqual(first); expect(await db.collection("mesh_jobs").countDocuments({ session_id: sid })).toBe(0);
    await panel.getByRole("button", { name: "Place in scene", exact: true }).click();
    await page.getByLabel("Object name", { exact: true }).fill("Fixture landmark"); await page.getByLabel("Object x", { exact: true }).fill("12"); await page.getByLabel("Object z", { exact: true }).fill("12");
    await page.getByLabel("Object width", { exact: true }).fill("2"); await page.getByLabel("Object rotation", { exact: true }).fill("20"); await page.getByLabel("Source pitch", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await saved(2);
    const originalScene = (await db.collection("place_scenes").findOne({ session_id: sid }))!, originalObject = originalScene.definition.objects[0];
    const views = page.getByRole("region", { name: "Saved camera views", exact: true });
    await views.getByRole("button", { name: "Save camera view", exact: true }).click(); await expect(views.getByRole("status").filter({ hasText: "Current geometry" })).toBeVisible();
    await panel.getByLabel("GLB file").setInputFiles({ name: "Wide replacement.glb", mimeType: "model/gltf-binary", buffer: second }); await panel.getByRole("button", { name: "Import GLB", exact: true }).click();
    const item = panel.getByRole("list", { name: "Saved meshes" }).getByRole("listitem").filter({ hasText: "Wide replacement.glb" });
    await item.getByRole("button", { name: "Replace selected mesh", exact: true }).click();
    await expect(page.getByLabel("Object name", { exact: true })).toHaveValue("Fixture landmark"); await expect(page.getByLabel("Object x", { exact: true })).toHaveValue("12");
    await expect(page.getByLabel("Source pitch", { exact: true })).toHaveValue("0"); await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("1");
    await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked(); await expect(views.getByRole("button", { name: "Save camera view", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Undo draft edit", exact: true }).click(); await expect(page.getByLabel("Source pitch", { exact: true })).toHaveValue("1"); await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("3");
    await item.getByRole("button", { name: "Replace selected mesh", exact: true }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await expect(page.getByRole("region", { name: "World change preview" })).toContainText("Replace Fixture landmark mesh asset");
    await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await saved(3);
    const replaced = (await db.collection("place_scenes").findOne({ session_id: sid }))!.definition.objects[0];
    expect(replaced).toMatchObject({ id: originalObject.id, entity_id: originalObject.entity_id, x: originalObject.x, z: originalObject.z, heading: originalObject.heading, label: originalObject.label, width: 2, height: 1, depth: 1.5 });
    expect(replaced.asset_id).not.toBe(originalObject.asset_id); await expect(views.getByRole("status").filter({ hasText: "Historical geometry" })).toBeVisible();
    const region = page.getByRole("region", { name: "Live 3D", exact: true }), viewport = region.getByTestId("place-viewport"); await region.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute("data-ready", "true");
    await expect.poll(() => region.locator("canvas").evaluate(el => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 128; const ctx = canvas.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
      const pixels = ctx.getImageData(0, 0, 128, 128).data; let purple = 0, yellow = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i]! > pixels[i + 1]! * 1.2 && pixels[i + 2]! > pixels[i + 1]! * 1.2) purple++; if (pixels[i]! > pixels[i + 2]! * 1.2 && pixels[i + 1]! > pixels[i + 2]! * 1.2) yellow++; }
      return Math.min(purple, yellow);
    })).toBeGreaterThan(30);
    const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
    await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .6, { steps: 12 }); await page.mouse.up(); await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
    await region.screenshot({ path: `test-results/mesh-import-textures-${width}.png` }); await panel.screenshot({ path: `test-results/mesh-import-library-${width}.png` });
    await page.getByRole("button", { name: "Duplicate mesh", exact: true }).click(); await expect(page.getByLabel("Object name", { exact: true })).toHaveValue("Fixture landmark copy");
    await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await saved(4);
    const scene = (await db.collection("place_scenes").findOne({ session_id: sid }))!; expect(scene.definition.objects).toHaveLength(2);
    expect(scene.definition.objects[0]).toEqual(replaced); expect(scene.definition.objects[1]).toMatchObject({ asset_id: replaced.asset_id, width: 2, height: 1, depth: 1.5 }); expect(scene.definition.objects[1].id).not.toBe(replaced.id);
    await page.reload(); await ready();
    const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body()), manifest = JSON.parse(await zip.file("mesh-assets.json")!.async("string"));
    expect(manifest).toHaveLength(2); for (const asset of manifest) { expect(asset.model).toBe("imported/glb"); expect(asset).not.toHaveProperty("request_id"); expect(asset.imported.kind).toBe("imported_mesh"); expect(await zip.file(asset.file)!.async("nodebuffer")).toEqual(asset.id === originalAsset.id ? first : second); }
    const foreign = await browser.newContext(); try {
      expect((await foreign.request.post(`${endpoint}/import`, { headers: { "Content-Type": "model/gltf-binary", "X-Mesh-Filename": "private.glb" }, data: second })).status()).toBe(403);
      expect((await foreign.request.get(`${endpoint}/${originalAsset.id}`)).status()).toBe(403);
    } finally { await foreign.close(); }
    const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
    await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
    expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition.objects).toEqual(scene.definition.objects);
    expect((await db.collection("mesh_assets").findOne({ session_id: fork.session_id, id: originalAsset.id }))!.imported).toEqual(originalAsset.imported);
    expect(await db.collection("mesh_jobs").countDocuments({ session_id: fork.session_id })).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
    expect([submissions, meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual(before);
    expect(await db.collection("spend_ledger").countDocuments({ _id: `sess:${sid}:${new Date().toISOString().slice(0, 10)}` as never })).toBe(0);
  } finally { worker = await startWorker(); }
});

for (const width of [1280, 390]) test(`image concept to durable mesh at ${width}`, async ({ page, browser }) => {
  test.setTimeout(180_000);
  meshImageEnabled = true; meshReady = false; failStorage = false;
  const before = meshSubmissions, errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Image mesh workflow fixture ${width}`);
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, db = client.db(name), endpoint = `${origin}/api/world/${sid}/meshes`;
  const panel = page.getByRole("region", { name: "AI 3D generation" });
  await panel.getByRole("button", { name: "Image", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Generate mesh", exact: true })).toBeDisabled();
  // Real upload UI, deliberately labelled fixture. No generation-quality claim.
  const original = await sharp(fixtureMaterial()).resize(96, 64).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await panel.getByLabel("Upload concept file").setInputFiles({ name: "Rotated concept fixture.jpg", mimeType: "image/jpeg", buffer: original });
  await expect(panel.getByRole("img")).toBeVisible();
  await expect.poll(() => panel.getByRole("img").evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([64, 96]);
  const source = (await db.collection("mesh_sources").findOne({ session_id: sid }))!;
  expect(blobs.get(source.original.key)).toEqual(original);
  expect(meshSubmissions).toBe(before);
  await panel.getByLabel("Mesh asset name").fill("IMAGE FIXTURE - saved concept mesh");
  await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: `test-results/image-mesh-input-${width}.png` });
  const writes: string[] = []; let loseResponse = true;
  await page.route(`**/api/world/${sid}/meshes`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    writes.push(route.request().postData()!); const response = await route.fetch();
    if (loseResponse && response.ok()) { loseResponse = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate mesh", exact: true }).click();
  await panel.getByRole("button", { name: "Retry saved mesh request", exact: true }).click();
  await expect.poll(() => meshSubmissions).toBe(before + 1); expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]);
  await expect.poll(async () => !!(await db.collection("mesh_jobs").findOne({ session_id: sid }))?.request_id).toBe(true);
  const job = (await db.collection("mesh_jobs").findOne({ session_id: sid }))!;
  expect(job.image_input.sha256).toBe(source.sha256);
  expect(Buffer.from(meshInputs.get(before + 1)!.input_image_url!.split(",")[1]!, "base64")).toEqual(blobs.get(source.key));
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.revision).toBe(1);
  await stopWorker(worker, "SIGKILL"); await page.goto("about:blank"); await stopApp();
  await db.collection("mesh_jobs").updateOne({ session_id: sid }, { $set: { work_until: new Date(0), next_check: new Date(0) } });
  failStorage = true; meshReady = true; worker = await startWorker();
  await expect.poll(async () => (await db.collection("mesh_jobs").findOne({ session_id: sid }))?.status).toBe("storage_failed");
  expect(meshSubmissions).toBe(before + 1);
  await startApp(); await page.goto(url); await ready();
  failStorage = false; await panel.getByRole("button", { name: "Retry mesh storage", exact: true }).click();
  await panel.getByRole("button", { name: "Place in scene", exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await page.getByLabel("Object width", { exact: true }).fill("2");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("4");
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await ready();
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click();
  const region = page.getByRole("region", { name: "Live 3D", exact: true }), viewport = region.getByTestId("place-viewport");
  await region.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect.poll(() => region.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
    const pixels = ctx.getImageData(0, 0, 128, 128).data; let green = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1]! > pixels[i]! * 1.3 && pixels[i + 1]! > pixels[i + 2]! * 1.1) green++; return green;
  })).toBeGreaterThan(50);
  const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .6, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
  await region.screenshot({ path: `test-results/image-mesh-placed-${width}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const asset = (await db.collection("mesh_assets").findOne({ session_id: sid }))!;
  expect(asset.image_input).toEqual(job.image_input);
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  const exported = JSON.parse(await zip.file("mesh-assets.json")!.async("string"))[0];
  expect(exported.image_input.sha256).toBe(source.sha256);
  expect(await zip.file(exported.image_input.file)!.async("nodebuffer")).toEqual(blobs.get(source.key));
  expect(await zip.file(exported.image_input.original.file)!.async("nodebuffer")).toEqual(original);
  expect(JSON.stringify(exported)).not.toContain(source.key);
  const foreign = await browser.newContext(); try {
    for (const path of ["/sources", `/sources/${source.id}`, `/${asset.id}`]) expect((await foreign.request.get(endpoint + path)).status()).toBe(403);
    expect((await foreign.request.post(`${endpoint}/sources`, { data: { node_id: "foreign" } })).status()).toBe(403);
  } finally { await foreign.close(); }
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
  expect((await db.collection("mesh_assets").findOne({ session_id: fork.session_id }))!.image_input.sha256).toBe(source.sha256);
  expect(await (await page.request.get(`${origin}/api/world/${fork.session_id}/meshes/sources/${source.id}`)).body()).toEqual(blobs.get(source.key));
  await expect(panel.getByRole("list", { name: "Saved meshes" }).getByRole("button", { name: "Place in scene" })).toBeVisible();
  await panel.getByRole("button", { name: "Image", exact: true }).click(); await panel.getByLabel("Concept image").selectOption(`source:${source.id}`);
  await expect.poll(() => panel.getByRole("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);
  await page.reload(); await ready(); expect(meshSubmissions).toBe(before + 1); expect(errors).toEqual([]);
  meshImageEnabled = false;
});

for (const width of [1280, 390]) test(`durable mesh generation and storage at ${width}`, async ({ page, browser }) => {
  meshEnabled = true; meshReady = false; failStorage = true;
  illustrationEnabled = true; illustrationReady = false;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Mesh worker fixture ${width}`);
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, db = client.db(name), endpoint = `${origin}/api/world/${sid}/meshes`;
  const before = meshSubmissions, downloads = meshDownloads, panel = page.getByRole("region", { name: "AI 3D generation" });
  await panel.getByLabel("3D object description").fill("TEST FIXTURE - generated asset pipeline");
  await expect(panel.getByRole("button", { name: "Generate mesh", exact: true })).toBeDisabled();
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate mesh", exact: true }).click();
  await expect.poll(() => meshSubmissions).toBe(before + 1);
  await expect.poll(async () => !!(await db.collection("mesh_jobs").findOne({ session_id: sid }))?.request_id).toBe(true);
  const job = (await db.collection("mesh_jobs").findOne({ session_id: sid }))!;
  const input = { action: "generate", id: job.id, prompt: job.prompt, confirmed: true, model: MESH_MODEL, reservation: 2, parameters: meshParameters };
  const duplicates = await Promise.all([page.request.post(endpoint, { data: input }), page.request.post(endpoint, { data: input })]); expect(duplicates.every(r => r.ok())).toBe(true);
  await stopWorker(worker, "SIGKILL"); await page.goto("about:blank"); await stopApp();
  // Expire only a test-owned read lease. The real saved provider ID is retained.
  await db.collection("mesh_jobs").updateOne({ session_id: sid }, { $set: { work_until: new Date(Date.now() - 1), next_check: new Date(Date.now() - 1) } });
  meshReady = true; worker = await startWorker(); const competitor = await startWorker();
  await expect.poll(async () => (await db.collection("mesh_jobs").findOne({ session_id: sid }))?.status).toBe("storage_failed");
  expect(meshSubmissions).toBe(before + 1); expect(meshDownloads).toBe(downloads + 1);
  expect(await db.collection("mesh_assets").countDocuments({ session_id: sid })).toBe(0);
  await stopWorker(competitor); await startApp(); await page.goto(url); await ready();
  await expect(panel.getByRole("button", { name: "Retry mesh storage" })).toBeVisible();
  await page.reload(); await ready(); expect(meshDownloads).toBe(downloads + 1);
  failStorage = false; await panel.getByRole("button", { name: "Retry mesh storage" }).click();
  await expect(panel.getByRole("button", { name: "Place in scene", exact: true })).toBeVisible();
  const asset = (await db.collection("mesh_assets").findOne({ session_id: sid }))!;
  expect(asset.request_id).toBe(job.request_id); expect(asset.parameters).toEqual(meshParameters); expect(blobs.get(asset.key)).toEqual(fixtureGlb());
  await panel.getByRole("button", { name: "Place in scene", exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Object width", { exact: true })).toHaveValue("1.5");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("2.25");
  await page.getByLabel("Object width", { exact: true }).fill("2");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("3");
  await page.getByLabel("Source pitch", { exact: true }).selectOption("1");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("4");
  await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
  await expect(page.getByLabel("Source pitch", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("4");
  await page.getByLabel("Source pitch", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click();
  const region = page.getByRole("region", { name: "Live 3D", exact: true }); await region.scrollIntoViewIfNeeded();
  const viewport = region.getByTestId("place-viewport"); await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect.poll(() => region.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
    const data = ctx.getImageData(0, 0, 128, 128).data; let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1]! > data[i]! * 1.3 && data[i + 1]! > data[i + 2]! * 1.1) count++; return count;
  })).toBeGreaterThan(50);
  const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height * .52, { steps: 20 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
  const cameraPath = page.getByRole("region", { name: "Camera path", exact: true });
  await cameraPath.getByRole("button", { name: "Camera path", exact: true }).click();
  const startAngle = Number(await cameraPath.getByRole("spinbutton", { name: "Azimuth value" }).inputValue());
  await cameraPath.getByRole("button", { name: "Camera keyframe 2", exact: true }).click();
  await cameraPath.getByRole("spinbutton", { name: "Azimuth value" }).fill(String(startAngle + 25));
  await cameraPath.getByRole("button", { name: "Rewind camera path", exact: true }).click();
  await page.waitForTimeout(100);
  const viewPanel = page.getByRole("region", { name: "Saved camera views", exact: true });
  const captured: ViewCapture[] = [];
  let loseResponse = true;
  await page.route(`**/api/world/${sid}/places/*/views`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    captured.push(route.request().postDataJSON().capture);
    const response = await route.fetch();
    if (loseResponse && response.ok()) { loseResponse = false; await route.abort("failed"); }
    else await route.fulfill({ response });
  });
  const captureCamera = await viewport.getAttribute("data-camera");
  await viewPanel.getByRole("button", { name: "Save camera view", exact: true }).click();
  await expect(viewPanel.getByRole("button", { name: "Retry saved view request", exact: true })).toBeEnabled();
  await viewPanel.getByRole("button", { name: "Retry saved view request", exact: true }).click();
  await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText("Current geometry / orbit");
  expect(captured).toHaveLength(2); expect(captured[1]).toEqual(captured[0]);
  expect(await db.collection("place_views").countDocuments({ session_id: sid })).toBe(1);
  expect(await viewport.getAttribute("data-camera")).toBe(captureCamera);
  const orbitCapture = captured[0]!;
  expect(orbitCapture.path?.keyframes).toHaveLength(2);
  expect(orbitCapture.path?.target_id).toBe(orbitCapture.sources[0]!.definition.objects[0]!.id);
  const decode = (pass: typeof VIEW_PASSES[number]) => sharp(Buffer.from(orbitCapture.passes[pass].split(",")[1]!, "base64")).ensureAlpha().raw().toBuffer();
  const objectPixels = await decode("objects"), depthPixels = await decode("depth"), normalPixels = await decode("normals");
  const rgb = orbitCapture.objects[0]!.rgb, depths = new Set<number>(), normals = new Set<string>(); let maskPixels = 0, invalidMask = 0, invalidDepth = 0;
  for (let i = 0; i < objectPixels.length; i += 4) {
    const pixel = [objectPixels[i]!, objectPixels[i + 1]!, objectPixels[i + 2]!];
    if (!pixel.every(v => v === 0) && !pixel.every((v, j) => v === rgb[j])) invalidMask++;
    if (pixel.every((v, j) => v === rgb[j])) {
      maskPixels++; if (depthPixels[i] !== depthPixels[i + 1] || depthPixels[i] !== depthPixels[i + 2]) invalidDepth++;
      depths.add(depthPixels[i]!); normals.add(`${normalPixels[i]},${normalPixels[i + 1]},${normalPixels[i + 2]}`);
    }
  }
  expect(invalidMask).toBe(0); expect(invalidDepth).toBe(0); expect(maskPixels).toBeGreaterThan(50); expect(depths.size).toBeGreaterThan(2); expect(normals.size).toBeGreaterThan(1);
  // Compare actual captured data with analytic intersections against the known
  // box-shaped GLB, including the saved source correction and camera transform.
  const object = orbitCapture.sources[0]!.definition.objects[0]!;
  const box = new Mesh(new BoxGeometry(object.width, object.height, object.depth), new MeshBasicMaterial());
  box.position.set(object.x, object.height / 2, object.z); box.rotation.y = -object.heading; box.updateMatrixWorld(true);
  const oracleCamera = new PerspectiveCamera(); oracleCamera.matrixWorld.fromArray(orbitCapture.camera.world_matrix);
  oracleCamera.matrixWorldInverse.copy(oracleCamera.matrixWorld).invert(); oracleCamera.projectionMatrix.fromArray(orbitCapture.camera.projection_matrix); oracleCamera.projectionMatrixInverse.copy(oracleCamera.projectionMatrix).invert();
  const ray = new Raycaster(), normalMatrix = new Matrix3().getNormalMatrix(oracleCamera.matrixWorldInverse.clone().multiply(box.matrixWorld)); let checked = 0;
  for (let pixel = 0; pixel < objectPixels.length / 4; pixel += 193) {
    if (!rgb.every((v, j) => objectPixels[pixel * 4 + j] === v)) continue;
    const x = pixel % orbitCapture.width, y = Math.floor(pixel / orbitCapture.width);
    ray.setFromCamera(new Vector2((x + .5) / orbitCapture.width * 2 - 1, 1 - (y + .5) / orbitCapture.height * 2), oracleCamera);
    const hit = ray.intersectObject(box)[0]; expect(hit).toBeDefined();
    const expectedDepth = -hit!.point.clone().applyMatrix4(oracleCamera.matrixWorldInverse).z;
    const range = orbitCapture.depth.far - orbitCapture.depth.near;
    const recoveredDepth = orbitCapture.depth.near + (1 - depthPixels[pixel * 4]! / 255) * range;
    expect(Math.abs(recoveredDepth - expectedDepth)).toBeLessThan(range / 255 * .6 + .001);
    const normal = hit!.face!.normal.clone().applyNormalMatrix(normalMatrix).toArray();
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(normalPixels[pixel * 4 + channel]! - (normal[channel]! * .5 + .5) * 255)).toBeLessThan(1);
    checked++; if (checked >= 32) break;
  }
  box.geometry.dispose(); box.material.dispose(); expect(checked).toBeGreaterThan(5);
  for (const pass of VIEW_PASSES) {
    await viewPanel.getByRole("button", { name: pass[0]!.toUpperCase() + pass.slice(1), exact: true }).click();
    const image = viewPanel.getByRole("img"); await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(orbitCapture.width);
  }
  await viewPanel.screenshot({ path: `test-results/camera-view-library-${width}.png` });
  const savedOrbit = (await db.collection("place_views").findOne({ session_id: sid, mode: "orbit" }))!;
  const illustrationPanel = viewPanel.getByLabel("Camera illustrations", { exact: true });
  const illustrationEndpoint = `${origin}/api/world/${sid}/views/${savedOrbit.id}/illustrations`;
  const illustrationBefore = illustrationSubmissions, illustrationWrites: string[] = [];
  let loseIllustrationResponse = true;
  await page.route(`**/api/world/${sid}/views/${savedOrbit.id}/illustrations`, async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "generate") { await route.continue(); return; }
    illustrationWrites.push(route.request().postData()!); const response = await route.fetch();
    if (loseIllustrationResponse && response.ok()) { loseIllustrationResponse = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await illustrationPanel.getByLabel("Illustration appearance").fill("TEST FIXTURE - saved camera illustration");
  await expect(illustrationPanel.getByRole("button", { name: "Generate illustration", exact: true })).toBeDisabled();
  await illustrationPanel.getByRole("checkbox").check(); await illustrationPanel.getByRole("button", { name: "Generate illustration", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Retry illustration request", exact: true })).toBeEnabled();
  await illustrationPanel.getByRole("button", { name: "Retry illustration request", exact: true }).click();
  await expect.poll(() => illustrationSubmissions).toBe(illustrationBefore + 1);
  expect(illustrationWrites).toHaveLength(2); expect(illustrationWrites[1]).toBe(illustrationWrites[0]);
  await expect.poll(async () => !!(await db.collection("illustration_jobs").findOne({ session_id: sid }))?.request_id).toBe(true);
  await stopWorker(worker, "SIGKILL");
  await db.collection("illustration_jobs").updateMany({ session_id: sid }, { $set: { work_until: new Date(0), next_check: new Date(0) } });
  illustrationReady = true; worker = await startWorker();
  await expect(illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true })).toBeEnabled();
  const illustrationAsset = (await db.collection("illustration_assets").findOne({ session_id: sid }))!;
  const illustrationFixture = illustrationFixtures.get(illustrationBefore + 1)!;
  expect(illustrationFixture.inputs.image_url).toBe(orbitCapture.passes.render);
  expect(illustrationFixture.inputs.control_lora_image_url).toBe(orbitCapture.passes.depth);
  expect(illustrationFixture.inputs.image_size).toEqual({ width: orbitCapture.width, height: orbitCapture.height });
  await illustrationPanel.getByRole("button", { name: "Source render", exact: true }).click();
  await expect(illustrationPanel.getByRole("img", { name: "Illustration source geometry" })).toBeVisible();
  await illustrationPanel.getByRole("button", { name: "Overlay", exact: true }).click();
  const sourceOpacity = illustrationPanel.getByRole("slider", { name: "Source render opacity" });
  await sourceOpacity.focus(); await sourceOpacity.press("Home");
  await expect(sourceOpacity).toHaveValue("0");
  await sourceOpacity.press("End"); await expect(sourceOpacity).toHaveValue("100");
  await expect(illustrationPanel.getByRole("img", { name: "Illustration source geometry" })).toHaveCSS("opacity", "1");
  await sourceOpacity.press("ArrowLeft"); await expect(sourceOpacity).toHaveValue("95");
  await expect(illustrationPanel.getByRole("img", { name: "Illustration source geometry" })).toHaveCSS("opacity", "0.95");
  expect(illustrationSubmissions).toBe(illustrationBefore + 1);
  await illustrationPanel.getByRole("button", { name: "Illustration", exact: true }).click();
  await illustrationPanel.getByRole("button", { name: "Edit selected objects", exact: true }).click();
  const objectCheckbox = illustrationPanel.getByRole("checkbox", { name: orbitCapture.objects[0]!.object_id, exact: true });
  await expect(objectCheckbox).toBeEnabled();
  await objectCheckbox.press("Space"); await expect(objectCheckbox).toBeChecked();
  await objectCheckbox.press("Space"); await expect(objectCheckbox).not.toBeChecked();
  const overlay = page.getByLabel("Object selection overlay", { exact: true });
  await overlay.scrollIntoViewIfNeeded(); const overlayRect = (await overlay.boundingBox())!;
  const visiblePixels: number[] = [];
  for (let i = 0; i < objectPixels.length; i += 4) if (rgb.every((v, j) => objectPixels[i + j] === v)) visiblePixels.push(i / 4);
  const hitPixel = visiblePixels[Math.floor(visiblePixels.length / 2)]!;
  await page.mouse.click(overlayRect.x + (hitPixel % orbitCapture.width + .5) / orbitCapture.width * overlayRect.width, overlayRect.y + (Math.floor(hitPixel / orbitCapture.width) + .5) / orbitCapture.height * overlayRect.height);
  await expect(objectCheckbox).toBeChecked();
  await expect.poll(() => overlay.evaluate(el => {
    const c = el as HTMLCanvasElement, pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++; return count;
  })).toBe(maskPixels);
  await illustrationPanel.getByRole("button", { name: "Preview selected edit", exact: true }).scrollIntoViewIfNeeded();
  await expect(illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true })).toHaveCount(0);
  await expect(overlay).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `test-results/region-edit-selection-${width}.png` });
  let loseRegionResponse = true; const regionWrites: string[] = [];
  await page.route(`**/api/world/${sid}/views/${savedOrbit.id}/illustrations`, async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "compose") { await route.fallback(); return; }
    regionWrites.push(route.request().postData()!); const response = await route.fetch();
    if (loseRegionResponse && response.ok()) { loseRegionResponse = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await illustrationPanel.getByRole("button", { name: "Preview selected edit", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Retry selected edit", exact: true })).toBeEnabled();
  await illustrationPanel.getByRole("button", { name: "Retry selected edit", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Previous artwork", exact: true })).toBeVisible();
  expect(regionWrites).toHaveLength(2); expect(regionWrites[0]).toBe(regionWrites[1]);
  let regionAsset = (await db.collection("illustration_assets").findOne({ session_id: sid, region_edit: { $exists: true } }))!;
  expect(regionAsset.region_edit).toMatchObject({ proposal_id: illustrationAsset.id, base_id: null, object_ids: [orbitCapture.objects[0]!.object_id], selected_pixels: maskPixels, protected_pixels: orbitCapture.width * orbitCapture.height - maskPixels });
  const regionResponse = await page.request.get(`${origin}/api/world/${sid}/illustrations/${regionAsset.id}`);
  expect(regionResponse.headers()["content-type"]).toBe("image/png"); let regionBytes = await regionResponse.body();
  const regionPixels = await sharp(regionBytes).ensureAlpha().raw().toBuffer(), basePixels = await decode("render"), proposalPixels = await sharp(illustrationFixture.bytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < objectPixels.length; i += 4) {
    const expected = rgb.every((v, j) => objectPixels[i + j] === v) ? proposalPixels : basePixels;
    if (!regionPixels.subarray(i, i + 4).equals(expected.subarray(i, i + 4))) throw new Error(`Region composite mismatched registered pixel ${i / 4}`);
  }
  expect((await db.collection("place_views").findOne({ _id: savedOrbit._id }))!.accepted_illustration_id).toBeUndefined();
  await illustrationPanel.getByRole("button", { name: "Previous artwork", exact: true }).click();
  await expect(illustrationPanel.getByRole("img", { name: "Region edit previous artwork" })).toBeVisible();
  await illustrationPanel.getByRole("button", { name: "Illustration", exact: true }).click();
  await illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
  await illustrationPanel.getByRole("button", { name: "Edit selected objects", exact: true }).click();
  await illustrationPanel.getByRole("button", { name: "Generate change", exact: true }).click();
  await objectCheckbox.check(); await illustrationPanel.getByLabel("Selected object change", { exact: true }).fill("TEST FIXTURE - blue roof tile change");
  await illustrationPanel.getByRole("button", { name: "Brush region", exact: true }).click();
  await viewPanel.getByRole("button", { name: "Open illustration", exact: true }).click();
  const illustrationStage = page.getByRole("region", { name: "Illustration workspace", exact: true });
  await expect(illustrationStage.getByLabel("Object selection overlay", { exact: true })).toBeVisible();
  await expect(page.getByTestId("place-viewport")).toHaveCount(0);
  expect((await illustrationPanel.getByRole("toolbar", { name: "Region selection tools" }).boundingBox())!.height).toBeLessThanOrEqual(40);
  await expect(illustrationPanel.getByText(/objects \/ .* protected pixels/)).toHaveCount(0);
  const setBrushRadius = async (value: number) => {
    const slider = illustrationPanel.getByLabel("Brush radius", { exact: true }); await slider.press("Home");
    for (let i = 1; i < value; i++) await slider.press("ArrowRight");
  };
  await setBrushRadius(8);
  await overlay.scrollIntoViewIfNeeded();
  const paintStroke = async (cancel = false) => {
    const box = (await overlay.boundingBox())!;
    const x = box.x + (hitPixel % orbitCapture.width + .5) / orbitCapture.width * box.width;
    const y = box.y + (Math.floor(hitPixel / orbitCapture.width) + .5) / orbitCapture.height * box.height;
    const dx = 12 / orbitCapture.width * box.width;
    if (width === 390) {
      const touch = await page.context().newCDPSession(page);
      try {
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y, id: 1 }] });
        await touch.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
      } finally { await touch.detach(); }
    } else {
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 4 }); await page.mouse.up();
    }
  };
  const paintedCount = () => overlay.evaluate(el => {
    const c = el as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let count = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) count++; return count;
  });
  const scrollBeforeBrush = await page.evaluate(() => window.scrollY);
  await paintStroke(); await expect.poll(paintedCount).toBeGreaterThan(20);
  const paintedBeforeErase = await paintedCount(); expect(paintedBeforeErase).toBeLessThan(maskPixels / 2);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeBrush);
  await page.getByRole("navigation", { name: "Place view" }).getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  await expect.poll(paintedCount).toBe(paintedBeforeErase);
  await viewPanel.getByRole("button", { name: "Open illustration", exact: true }).click();
  await expect.poll(paintedCount).toBe(paintedBeforeErase);
  expect(await illustrationPanel.getByLabel("Selected object change", { exact: true }).inputValue()).toBe("TEST FIXTURE - blue roof tile change");
  await illustrationPanel.getByRole("button", { name: "Erase region", exact: true }).click();
  await setBrushRadius(2); await overlay.scrollIntoViewIfNeeded();
  await paintStroke(); expect(await paintedCount()).toBeLessThan(paintedBeforeErase);
  await illustrationPanel.getByRole("button", { name: "Undo region stroke", exact: true }).click(); expect(await paintedCount()).toBe(paintedBeforeErase);
  if (width === 390) { await overlay.scrollIntoViewIfNeeded(); await paintStroke(true); expect(await paintedCount()).toBe(paintedBeforeErase); }
  await illustrationPanel.getByRole("button", { name: "Clear region strokes", exact: true }).click(); expect(await paintedCount()).toBe(0);
  await illustrationPanel.getByRole("button", { name: "Brush region", exact: true }).click();
  await setBrushRadius(8); await overlay.scrollIntoViewIfNeeded(); await paintStroke();
  const brushPixelCount = await paintedCount();
  const brushOverlay = await sharp(Buffer.from((await overlay.evaluate(el => (el as HTMLCanvasElement).toDataURL("image/png"))).split(",")[1]!, "base64")).ensureAlpha().raw().toBuffer();
  await illustrationPanel.screenshot({ path: `test-results/registered-brush-${width}.png` });
  await illustrationStage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/illustration-workspace-${width}.png` });
  const fittedArtwork = (await overlay.boundingBox())!, stageBounds = (await illustrationStage.boundingBox())!;
  expect(fittedArtwork.width).toBeGreaterThan(width === 390 ? 300 : 500);
  expect(fittedArtwork.x).toBeGreaterThanOrEqual(stageBounds.x); expect(fittedArtwork.x + fittedArtwork.width).toBeLessThanOrEqual(stageBounds.x + stageBounds.width + 1);
  expect(fittedArtwork.y + fittedArtwork.height).toBeLessThanOrEqual(stageBounds.y + stageBounds.height);
  await page.getByRole("navigation", { name: "Place view" }).getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  await expect(illustrationPanel.getByRole("button", { name: "Generate selected change", exact: true })).toBeDisabled();
  await illustrationPanel.getByRole("checkbox", { name: "Approve masked generation reservation", exact: true }).check();
  await illustrationPanel.getByRole("button", { name: "Generate selected change", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/masked-generation-controls-${width}.png` });
  const maskedWrites: string[] = []; let loseMaskedResponse = true; illustrationReady = false;
  await page.route(`**/api/world/${sid}/views/${savedOrbit.id}/illustrations`, async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "generate_region") { await route.fallback(); return; }
    maskedWrites.push(route.request().postData()!); const response = await route.fetch();
    if (loseMaskedResponse && response.ok()) { loseMaskedResponse = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await illustrationPanel.getByRole("button", { name: "Generate selected change", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Retry masked request", exact: true })).toBeEnabled();
  await illustrationPanel.getByRole("button", { name: "Retry masked request", exact: true }).click();
  await expect.poll(() => illustrationSubmissions).toBe(illustrationBefore + 2);
  expect(maskedWrites).toHaveLength(2); expect(maskedWrites[0]).toBe(maskedWrites[1]);
  await expect.poll(async () => !!(await db.collection("illustration_jobs").findOne({ session_id: sid, model: ILLUSTRATION_EDIT_MODEL }))?.request_id).toBe(true);
  await stopWorker(worker, "SIGKILL");
  await db.collection("illustration_jobs").updateMany({ session_id: sid }, { $set: { work_until: new Date(0), next_check: new Date(0) } });
  illustrationReady = true; worker = await startWorker();
  const maskedFixture = illustrationFixtures.get(illustrationBefore + 2)!;
  const inputBytes = (url: string) => Buffer.from(url.split(",")[1]!, "base64");
  expect(await sharp(inputBytes(maskedFixture.inputs.image_url)).ensureAlpha().raw().toBuffer()).toEqual(regionPixels);
  expect(maskedFixture.inputs.control_lora_image_url).toBe(orbitCapture.passes.depth);
  const binaryMask = await sharp(inputBytes(maskedFixture.inputs.mask_url!)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < binaryMask.length; i += 4) {
    const expected = brushOverlay[i + 3] ? 255 : 0;
    if (binaryMask[i] !== expected || binaryMask[i + 1] !== expected || binaryMask[i + 2] !== expected || binaryMask[i + 3] !== 255) throw new Error(`Binary edit mask mismatched pixel ${i / 4}`);
  }
  await expect.poll(async () => !!await db.collection("illustration_assets").findOne({ session_id: sid, model: ILLUSTRATION_EDIT_MODEL })).toBe(true);
  const maskedAsset = (await db.collection("illustration_assets").findOne({ session_id: sid, model: ILLUSTRATION_EDIT_MODEL }))!;
  expect(maskedAsset.edit_input.brush_strokes).toEqual(JSON.parse(maskedWrites[0]!).brush_strokes);
  await illustrationPanel.getByRole("button", { name: "Refresh illustrations", exact: true }).click();
  await illustrationPanel.getByLabel("Saved illustration", { exact: true }).selectOption(maskedAsset.id);
  await expect(illustrationPanel.getByRole("button", { name: "Preview protected result", exact: true })).toBeEnabled();
  expect((await page.request.post(illustrationEndpoint, { data: { action: "accept", id: maskedAsset.id, previous_id: regionAsset.id } })).status()).toBe(409);
  await illustrationPanel.getByRole("button", { name: "Preview protected result", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true })).toBeEnabled();
  await illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/masked-generation-preview-${width}.png` });
  const nextRegion = (await db.collection("illustration_assets").findOne({ session_id: sid, "region_edit.proposal_id": maskedAsset.id }))!;
  const nextBytes = await (await page.request.get(`${origin}/api/world/${sid}/illustrations/${nextRegion.id}`)).body();
  const nextPixels = await sharp(nextBytes).ensureAlpha().raw().toBuffer(), maskedProposal = await sharp(maskedFixture.bytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < nextPixels.length; i += 4) {
    const expected = binaryMask[i] ? maskedProposal : regionPixels;
    if (!nextPixels.subarray(i, i + 4).equals(expected.subarray(i, i + 4))) throw new Error(`Masked edit mismatched pixel ${i / 4}`);
  }
  expect(nextRegion.region_edit.base_id).toBe(regionAsset.id);
  expect(nextRegion.region_edit).toMatchObject({ method: "object_clipped_brush_rgba_v1", brush_strokes: maskedAsset.edit_input.brush_strokes, selected_pixels: brushPixelCount });
  await illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
  regionAsset = nextRegion; regionBytes = nextBytes;
  await illustrationPanel.screenshot({ path: `test-results/place-illustrations-${width}.png` });
  await viewPanel.getByRole("button", { name: "Open illustration", exact: true }).click();
  await expect(illustrationStage.getByRole("img", { name: "Generated camera illustration", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select ground", exact: true }).click();
  await expect.poll(paintedCount).toBe(0);
  await overlay.scrollIntoViewIfNeeded();
  const selectBox = (await overlay.boundingBox())!;
  await page.mouse.click(selectBox.x + (hitPixel % orbitCapture.width + .5) / orbitCapture.width * selectBox.width, selectBox.y + (Math.floor(hitPixel / orbitCapture.width) + .5) / orbitCapture.height * selectBox.height);
  await expect.poll(paintedCount).toBe(maskPixels);
  const selectedName = await page.getByLabel("Object name", { exact: true }).inputValue();
  expect(selectedName.length).toBeGreaterThan(0);
  await page.getByRole("navigation", { name: "Place view" }).getByRole("button", { name: "3D", exact: true }).click(); await ready();
  await expect(page.getByLabel("Object name", { exact: true })).toHaveValue(selectedName);
  await viewPanel.getByRole("button", { name: "Open illustration", exact: true }).click();
  await page.reload();
  await expect(illustrationStage.getByRole("img", { name: "Generated camera illustration", exact: true })).toBeVisible();
  await expect(viewPanel.getByLabel("Saved camera view", { exact: true })).toHaveValue(savedOrbit.id);
  await expect(page.getByTestId("place-viewport")).toHaveCount(0);
  expect(illustrationSubmissions).toBe(illustrationBefore + 2);
  await page.getByRole("navigation", { name: "Place view" }).getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.revision).toBe(2);
  for (const mode of ["Plan", "Walk"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click(); await ready();
    await viewPanel.getByLabel("View name", { exact: true }).fill(`${mode} fixture`);
    await viewPanel.getByRole("button", { name: "Save camera view", exact: true }).click();
    await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText(`Current geometry / ${mode.toLowerCase()}`);
  }
  expect(await db.collection("place_views").countDocuments({ session_id: sid })).toBe(3);
  expect(meshSubmissions).toBe(before + 1); expect(meshDownloads).toBe(downloads + 2);
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click(); await ready();
  await page.screenshot({ path: `test-results/mesh-worker-${width}.png` });
  await page.reload(); await ready();
  const scene = (await db.collection("place_scenes").findOne({ session_id: sid }))!;
  await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(savedOrbit.id);
  await viewPanel.getByRole("button", { name: "Load camera path", exact: true }).click();
  const restoredViewport = page.getByTestId("place-viewport");
  await expect(restoredViewport).toHaveAttribute("data-mode", "orbit");
  await expect(cameraPath.getByRole("button", { name: "Camera keyframe 2", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Place view" })).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => (await restoredViewport.getAttribute("data-projection"))?.split(",").map(Number)).toEqual(orbitCapture.camera.projection_matrix);
  await expect(restoredViewport).toHaveAttribute("data-camera", captureCamera!);
  const originalProjection = await restoredViewport.getAttribute("data-projection");
  await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 900 });
  await expect(restoredViewport).toHaveAttribute("data-projection", originalProjection!);
  const fitted = (await restoredViewport.locator("canvas").boundingBox())!;
  expect(fitted.width / fitted.height).toBeCloseTo(orbitCapture.camera.projection_matrix[5]! / orbitCapture.camera.projection_matrix[0]!, 2);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await cameraPath.getByRole("button", { name: "Play camera path", exact: true }).click();
  await expect(cameraPath.getByRole("button", { name: "Pause camera path", exact: true })).toBeVisible();
  await expect.poll(() => restoredViewport.getAttribute("data-camera")).not.toBe(captureCamera);
  await cameraPath.getByRole("button", { name: "Pause camera path", exact: true }).click();
  await cameraPath.getByRole("button", { name: "Rewind camera path", exact: true }).click();
  await page.screenshot({ path: `test-results/saved-camera-path-${width}.png` });
  expect(scene.definition.objects[0]).toMatchObject({ mesh_scale: "uniform", mesh_orientation: { x: 1, y: 0, z: 0 }, width: 2, height: 3, depth: 4 });
  expect((await db.collection("mesh_assets").findOne({ _id: asset._id }))!.geometry).toEqual({ sha256: asset.sha256, size: { width: 2, height: 4, depth: 3 } });
  const rejected = await page.request.post(`${origin}/api/world/${sid}/places/${scene.place_id}/scene`, { data: { action: "preview", base_revision: 2, definition: { ...scene.definition, objects: [{ ...scene.definition.objects[0], width: 3 }] } } });
  expect(rejected.status()).toBe(400);
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.revision).toBe(2);
  const unavailableBytes = blobs.get(regionAsset.key)!;
  expect(unavailableBytes).toBeDefined();
  blobs.delete(regionAsset.key);
  try {
    const failedExport = await page.request.get(`${origin}/api/export/session/${sid}`);
    expect(failedExport.status()).toBe(503);
    expect(failedExport.headers()["cache-control"]).toBe("private, no-store");
    expect(failedExport.headers()["content-type"]).toContain("application/json");
  } finally { blobs.set(regionAsset.key, unavailableBytes); }
  const exportResponse = await page.request.get(`${origin}/api/export/session/${sid}`);
  expect(exportResponse.status()).toBe(200);
  const zip = await JSZip.loadAsync(await exportResponse.body());
  const archiveManifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  expect(archiveManifest).toMatchObject({ format: "openflipbook-world-content", version: 1, session_id: sid, visibility: "owner", metadata_consistency: "database_snapshot", missing_files: [], restore_supported: false });
  expect(archiveManifest.files.map((f: { path: string }) => f.path).sort()).toEqual(Object.values(zip.files).filter(f => !f.dir && f.name !== "manifest.json").map(f => f.name).sort());
  for (const file of archiveManifest.files) {
    const data = await zip.file(file.path)!.async("nodebuffer"); expect(data.length).toBe(file.bytes);
    expect(createHash("sha256").update(data).digest("hex")).toBe(file.sha256);
  }
  expect(JSON.parse(await zip.file("place-scene-heads.json")!.async("string"))[0].revision).toBe(2);
  expect(JSON.parse(await zip.file("mesh-assets.json")!.async("string"))[0]).toMatchObject({ sha256: asset.sha256, request_id: job.request_id, parameters: meshParameters });
  expect(JSON.parse(await zip.file("place-scenes.json")!.async("string")).find((s: { revision: number }) => s.revision === 2).definition.objects[0]).toEqual(scene.definition.objects[0]);
  const exportedViews = JSON.parse(await zip.file("place-views.json")!.async("string")); expect(exportedViews).toHaveLength(3);
  const exportedOrbit = exportedViews.find((v: { mode: string }) => v.mode === "orbit");
  expect(exportedOrbit.camera).toEqual(orbitCapture.camera); expect(exportedOrbit.historical).toBe(false);
  expect(exportedOrbit.path).toEqual(orbitCapture.path);
  expect(exportedOrbit.accepted_illustration_id).toBe(regionAsset.id);
  expect(exportedOrbit.illustrations[0]).toMatchObject({ id: illustrationAsset.id, accepted: false, historical: false, view_dependency: illustrationAsset.view_dependency });
  expect(await zip.file(exportedOrbit.illustrations[0].file)!.async("nodebuffer")).toEqual(illustrationFixture.bytes);
  const exportedRegion = exportedOrbit.illustrations.find((a: { id: string }) => a.id === regionAsset.id);
  expect(exportedRegion).toMatchObject({ accepted: true, content_type: "image/png", region_edit: regionAsset.region_edit });
  expect(exportedRegion.file.endsWith(".png")).toBe(true); expect(await zip.file(exportedRegion.file)!.async("nodebuffer")).toEqual(regionBytes);
  const exportedMasked = exportedOrbit.illustrations.find((a: { id: string }) => a.id === maskedAsset.id);
  expect(exportedMasked.edit_input).toEqual(maskedAsset.edit_input); expect(await zip.file(exportedMasked.file)!.async("nodebuffer")).toEqual(maskedFixture.bytes);
  for (const p of exportedOrbit.passes) expect(await zip.file(p.file)!.async("uint8array")).toEqual(new Uint8Array(Buffer.from(orbitCapture.passes[p.pass as keyof ViewCapture["passes"]].split(",")[1]!, "base64")));
  const foreign = await browser.newContext(); try {
    expect((await foreign.request.get(`${endpoint}/${asset.id}`)).status()).toBe(403);
    expect((await foreign.request.get(`${endpoint}/${asset.id}?geometry=1`)).status()).toBe(403);
    const savedView = (await db.collection("place_views").findOne({ session_id: sid }))!;
    expect((await foreign.request.get(`${origin}/api/world/${sid}/views/${savedView.id}/render`)).status()).toBe(403);
    expect((await foreign.request.get(`${origin}/api/world/${sid}/places/${scene.place_id}/views`)).status()).toBe(403);
    expect((await foreign.request.get(illustrationEndpoint)).status()).toBe(403);
    expect((await foreign.request.get(`${origin}/api/world/${sid}/illustrations/${illustrationAsset.id}`)).status()).toBe(403);
    expect((await foreign.request.get(`${origin}/api/world/${sid}/illustrations/${regionAsset.id}`)).status()).toBe(403);
    expect((await foreign.request.post(illustrationEndpoint, { data: JSON.parse(regionWrites[0]!) })).status()).toBe(403);
  } finally { await foreign.close(); }
  const queuedId = crypto.randomUUID(); await stopWorker(worker);
  await db.collection("generation_workers").updateMany({}, { $set: { last_seen: new Date(Date.now() - 31_000) } });
  expect((await page.request.post(endpoint, { data: { ...input, id: queuedId } })).status()).toBe(503);
  worker = await startWorker();
  const queuedResponse = await page.request.post(endpoint, { data: { ...input, id: queuedId } }); expect(queuedResponse.ok()).toBe(true);
  // Cancellation may race the worker claim; either outcome must be consistent.
  const cancelled = await (await page.request.post(endpoint, { data: { action: "cancel", id: queuedId } })).json(); expect(cancelled.job.status).toBe("cancelled");
  await page.request.post(endpoint, { data: { action: "cancel", id: queuedId } });
  const cancelledDoc = (await db.collection("mesh_jobs").findOne({ session_id: sid, id: queuedId }))!;
  expect((await db.collection("spend_ledger").findOne({ _id: `sess:${sid}:${new Date().toISOString().slice(0, 10)}` as never }))!.total).toBeCloseTo(cancelledDoc.submission_token ? 4.2 : 2.2);
  const copyCollections = ["nodes", "world_map", "world_state", "creator_worlds", "place_scenes", "place_scene_versions", "place_connections", "mesh_sources", "mesh_assets", "material_assets", "place_views", "illustration_assets", "session_owners", "fork_receipts"];
  const counts = async () => { const result: Record<string, number> = {}; for (const name of copyCollections) result[name] = await db.collection(name).countDocuments(); return result; };
  const beforeCopy = await counts(), forkWrites: string[] = []; let lostFork = true;
  await page.route(`**/api/sessions/${sid}/fork`, async route => {
    forkWrites.push(route.request().postData()!);
    const responses = forkWrites.length === 2
      ? await Promise.all([route.fetch(), page.request.post(route.request().url(), { data: JSON.parse(route.request().postData()!) })])
      : [await route.fetch()];
    const response = responses[0]!;
    if (responses.length === 2) { expect(response.status()).toBe(200); expect(responses[1]!.status()).toBe(200); expect(await responses[1]!.json()).toEqual(await response.json()); }
    if (lostFork && response.ok()) { lostFork = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  // This validator belongs only to this suite's random isolated database.
  // Reject the late illustration insert, after geometry/assets were written.
  await db.command({ collMod: "illustration_assets", validator: { session_id: { $eq: sid } }, validationLevel: "strict", validationAction: "error" });
  try {
    await page.getByRole("button", { name: "Fork world", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Fork unavailable" })).toBeVisible();
    expect(await counts()).toEqual(beforeCopy);
  } finally { await db.command({ collMod: "illustration_assets", validator: {} }); }
  await page.getByRole("button", { name: "Fork world", exact: true }).click();
  await expect.poll(async () => db.collection("fork_receipts").countDocuments({ source_session_id: sid })).toBe(1);
  await expect(page.getByRole("button", { name: "Fork world", exact: true })).toBeEnabled();
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
  expect(forkWrites).toHaveLength(3); expect(new Set(forkWrites).size).toBe(1);
  expect(await db.collection("fork_receipts").countDocuments({ source_session_id: sid })).toBe(1);
  expect(await db.collection("session_owners").findOne({ _id: fork.session_id })).toBeTruthy();
  const copiedCounts = await counts(), copiedUrl = page.url();
  await page.goto("about:blank"); await stopApp(); await startApp();
  const replayBody = JSON.parse(forkWrites[0]!);
  const replays = await Promise.all([0, 1].map(() => page.request.post(`${origin}/api/sessions/${sid}/fork`, { data: replayBody })));
  for (const replay of replays) { expect(replay.status()).toBe(200); expect(await replay.json()).toEqual(fork); }
  expect(await counts()).toEqual(copiedCounts);
  expect((await page.request.post(`${origin}/api/sessions/${sid}/fork`, { data: { ...replayBody, node_id: "unrelated" } })).status()).toBe(409);
  await page.goto(copiedUrl); await ready();
  expect((await db.collection("mesh_assets").findOne({ session_id: fork.session_id }))!.sha256).toBe(asset.sha256);
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition.objects[0]).toEqual(scene.definition.objects[0]);
  expect(await db.collection("place_views").countDocuments({ session_id: fork.session_id })).toBe(3);
  const forkIllustrationEndpoint = `${origin}/api/world/${fork.session_id}/views/${savedOrbit.id}/illustrations`;
  expect((await (await page.request.get(forkIllustrationEndpoint)).json()).assets[0]).toMatchObject({ id: regionAsset.id, accepted: true, historical: false, region_edit: regionAsset.region_edit });
  expect(await (await page.request.get(`${origin}/api/world/${fork.session_id}/illustrations/${regionAsset.id}`)).body()).toEqual(regionBytes);
  const forkViews = await (await page.request.get(`${origin}/api/world/${fork.session_id}/places/${scene.place_id}/views`)).json();
  expect(forkViews.views.every((v: { historical: boolean }) => !v.historical)).toBe(true);
  expect(forkViews.views.find((v: { id: string }) => v.id === savedOrbit.id).path).toEqual(orbitCapture.path);
  await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(savedOrbit.id);
  await viewPanel.getByRole("button", { name: "Load camera path", exact: true }).click();
  await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-camera", captureCamera!);
  await expect.poll(async () => (await page.getByTestId("place-viewport").getAttribute("data-projection"))?.split(",").map(Number)).toEqual(orbitCapture.camera.projection_matrix);
  await page.getByRole("button", { name: `${scene.definition.objects[0].label} mesh`, exact: true }).click();
  await page.getByLabel("Object x", { exact: true }).fill(String(scene.definition.objects[0].x + 1));
  await expect(viewPanel.getByRole("button", { name: "Save camera view", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await ready();
  await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText("Historical geometry");
  await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(savedOrbit.id);
  await expect(viewPanel.getByRole("button", { name: "Load camera path", exact: true })).toBeDisabled();
  const stale = await page.request.post(`${origin}/api/world/${fork.session_id}/places/${scene.place_id}/views`, { data: { id: crypto.randomUUID(), label: "Obsolete capture", capture: orbitCapture } });
  expect(stale.status()).toBe(409);
  const historical = forkViews.views.find((v: { mode: string }) => v.mode === "orbit");
  const retained = await page.request.get(`${origin}/api/world/${fork.session_id}/views/${historical.id}/depth`);
  expect(await retained.body()).toEqual(Buffer.from(orbitCapture.passes.depth.split(",")[1]!, "base64"));
  const sourceViews = await (await page.request.get(`${origin}/api/world/${sid}/places/${scene.place_id}/views`)).json();
  expect(sourceViews.views.every((v: { historical: boolean }) => !v.historical)).toBe(true);
  expect((await (await page.request.get(forkIllustrationEndpoint)).json()).assets[0]).toMatchObject({ accepted: true, historical: true });
  expect((await page.request.post(forkIllustrationEndpoint, { data: { action: "accept", id: regionAsset.id, previous_id: regionAsset.id } })).status()).toBe(409);
  expect((await page.request.post(forkIllustrationEndpoint, { data: { ...JSON.parse(regionWrites[0]!), id: crypto.randomUUID(), base_id: regionAsset.id } })).status()).toBe(409);
  expect(await (await page.request.get(`${origin}/api/world/${fork.session_id}/illustrations/${illustrationAsset.id}`)).body()).toEqual(illustrationFixture.bytes);
  expect(illustrationSubmissions).toBe(illustrationBefore + 2);
  const oldForkView = (await db.collection("place_views").findOne({ session_id: fork.session_id, id: savedOrbit.id }))!;
  const beforeRefreshScene = (await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!;
  // Recapture an orbit frame from the Plan workspace: current viewport camera,
  // size and cutaway state must not replace the saved framing or exterior geometry.
  await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  const liveCamera = await page.getByTestId("place-viewport").getAttribute("data-camera");
  await viewPanel.getByRole("button", { name: "Open illustration", exact: true }).click();
  await expect(page.getByTestId("place-viewport")).toHaveCount(0);
  const refreshWrites: string[] = []; let loseRefresh = true;
  await page.route(`**/api/world/${fork.session_id}/places/*/views`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    refreshWrites.push(route.request().postData()!); const response = await route.fetch();
    if (loseRefresh && response.ok()) { loseRefresh = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await viewPanel.getByRole("button", { name: "Refresh saved view geometry", exact: true }).click();
  await expect(viewPanel.getByRole("button", { name: "Retry view refresh request", exact: true })).toBeEnabled();
  await viewPanel.getByRole("button", { name: "Retry view refresh request", exact: true }).click();
  await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText("Current geometry / orbit");
  expect(refreshWrites).toHaveLength(2); expect(refreshWrites[1]).toBe(refreshWrites[0]);
  const refreshedCapture = JSON.parse(refreshWrites[0]!).capture as ViewCapture;
  expect(refreshedCapture.camera).toEqual(orbitCapture.camera);
  expect([refreshedCapture.width, refreshedCapture.height]).toEqual([orbitCapture.width, orbitCapture.height]);
  expect(refreshedCapture.path).toBeUndefined();
  await expect(illustrationStage.getByRole("img", { name: "Saved camera source render", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Place view" }).getByRole("button", { name: "Plan", exact: true }).click(); await ready();
  expect(await page.getByTestId("place-viewport").getAttribute("data-camera")).toBe(liveCamera);
  const freshView = (await db.collection("place_views").findOne({ session_id: fork.session_id, refreshed_from: savedOrbit.id }))!;
  expect(await db.collection("place_views").countDocuments({ session_id: fork.session_id })).toBe(4);
  expect(await db.collection("place_views").findOne({ session_id: fork.session_id, id: savedOrbit.id })).toEqual(oldForkView);
  expect(freshView.accepted_illustration_id).toBeUndefined();
  const afterRefreshScene = (await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!;
  expect(afterRefreshScene.definition).toEqual(beforeRefreshScene.definition); expect(afterRefreshScene.revision).toBe(beforeRefreshScene.revision);
  for (const pass of ["render", "objects"] as const) {
    const oldPixels = await sharp(Buffer.from(orbitCapture.passes[pass].split(",")[1]!, "base64")).ensureAlpha().raw().toBuffer();
    const freshPixels = await sharp(Buffer.from(refreshedCapture.passes[pass].split(",")[1]!, "base64")).ensureAlpha().raw().toBuffer();
    expect(freshPixels.length).toBe(oldPixels.length);
    let changed = 0; for (let i = 0; i < freshPixels.length; i += 4) if ([0, 1, 2].some(j => freshPixels[i + j] !== oldPixels[i + j])) changed++;
    expect(changed).toBeGreaterThan(20);
    expect(new Set(freshPixels).size).toBeGreaterThan(1);
  }
  expect(illustrationSubmissions).toBe(illustrationBefore + 2);
  await viewPanel.getByRole("img", { name: `${freshView.label} render pass`, exact: true }).scrollIntoViewIfNeeded();
  await viewPanel.screenshot({ path: `test-results/view-geometry-refreshed-${width}.png` });
  await illustrationPanel.getByLabel("Illustration appearance").fill("TEST FIXTURE - refreshed geometry illustration");
  await expect(illustrationPanel.getByRole("button", { name: "Generate illustration", exact: true })).toBeDisabled();
  await illustrationPanel.getByRole("checkbox").check(); await illustrationPanel.getByRole("button", { name: "Generate illustration", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true })).toBeEnabled();
  expect(illustrationSubmissions).toBe(illustrationBefore + 3);
  const refreshedInput = illustrationFixtures.get(illustrationBefore + 3)!.inputs;
  expect(refreshedInput.image_url).toBe(refreshedCapture.passes.render); expect(refreshedInput.control_lora_image_url).toBe(refreshedCapture.passes.depth);
  const protectedWrites: string[] = []; let loseProtected = true;
  const refreshedEndpoint = `${origin}/api/world/${fork.session_id}/views/${freshView.id}/illustrations`;
  await page.route(refreshedEndpoint, async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "compose_refresh") { await route.continue(); return; }
    protectedWrites.push(route.request().postData()!); const response = await route.fetch();
    if (loseProtected && response.ok()) { loseProtected = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await illustrationPanel.getByRole("button", { name: "Preview protected refresh", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Retry artwork refresh", exact: true })).toBeEnabled();
  await illustrationPanel.getByRole("button", { name: "Retry artwork refresh", exact: true }).click();
  await expect(illustrationPanel.getByText(/refreshed pixels \/ .*protected pixels/)).toBeVisible();
  expect(protectedWrites).toHaveLength(2); expect(protectedWrites[1]).toBe(protectedWrites[0]);
  const protectedAsset = (await db.collection("illustration_assets").findOne({ session_id: fork.session_id, "geometry_refresh.base_view.view_id": savedOrbit.id }))!;
  expect(await db.collection("illustration_assets").countDocuments({ session_id: fork.session_id, geometry_refresh: { $exists: true } })).toBe(1);
  expect(protectedAsset.geometry_refresh).toMatchObject({ base_id: regionAsset.id, previous_id: null, method: "registered_render_delta_rgba_v1" });
  expect(protectedAsset.geometry_refresh.changed_pixels).toBeGreaterThan(20);
  expect(protectedAsset.geometry_refresh.protected_pixels).toBeGreaterThan(orbitCapture.width * orbitCapture.height / 2);
  const protectedBytes = await (await page.request.get(`${origin}/api/world/${fork.session_id}/illustrations/${protectedAsset.id}`)).body();
  const protectedPixels = await sharp(protectedBytes).ensureAlpha().raw().toBuffer();
  const previousPixels = await sharp(regionBytes).ensureAlpha().raw().toBuffer();
  const refreshProposalPixels = await sharp(illustrationFixtures.get(illustrationBefore + 3)!.bytes).ensureAlpha().raw().toBuffer();
  let unchangedArtwork = 0, changedArtwork = 0, unexpectedArtwork = 0;
  for (let i = 0; i < protectedPixels.length; i += 4) {
    const pixel = protectedPixels.subarray(i, i + 4);
    if (pixel.equals(previousPixels.subarray(i, i + 4))) unchangedArtwork++;
    else { if (!pixel.equals(refreshProposalPixels.subarray(i, i + 4))) unexpectedArtwork++; changedArtwork++; }
  }
  expect(unexpectedArtwork).toBe(0);
  expect(unchangedArtwork).toBeGreaterThanOrEqual(protectedAsset.geometry_refresh.protected_pixels);
  expect(changedArtwork).toBeGreaterThan(20);
  expect((await db.collection("place_views").findOne({ session_id: fork.session_id, id: freshView.id }))!.accepted_illustration_id).toBeUndefined();
  expect(await db.collection("place_views").findOne({ session_id: fork.session_id, id: savedOrbit.id })).toEqual(oldForkView);
  expect(illustrationSubmissions).toBe(illustrationBefore + 3);
  await illustrationPanel.getByRole("button", { name: "Previous artwork", exact: true }).click();
  await expect(illustrationPanel.getByRole("img", { name: "Region edit previous artwork", exact: true })).toHaveAttribute("src", new RegExp(`/illustrations/${regionAsset.id}$`));
  await illustrationPanel.getByRole("button", { name: "Illustration", exact: true }).click();
  await illustrationPanel.screenshot({ path: `test-results/protected-artwork-refresh-${width}.png` });
  await illustrationPanel.getByRole("button", { name: "Accept illustration", exact: true }).click();
  await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
  await viewPanel.getByRole("button", { name: "Previous view", exact: true }).click();
  await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText("Historical geometry");
  await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(freshView.id);
  await page.reload(); await ready(); await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(freshView.id);
  await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText("Current geometry");
  await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
  for (const mode of ["plan", "walk"]) {
    const oldView = forkViews.views.find((v: { mode: string }) => v.mode === mode);
    await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(oldView.id);
    await viewPanel.getByRole("button", { name: "Refresh saved view geometry", exact: true }).click();
    await expect(viewPanel.getByRole("status").filter({ hasText: /^(Current|Historical) geometry/ })).toContainText(`Current geometry / ${mode}`);
    const saved = (await db.collection("place_views").findOne({ session_id: fork.session_id, refreshed_from: oldView.id }))!;
    expect(saved.camera).toEqual(oldView.camera); expect([saved.width, saved.height]).toEqual([oldView.width, oldView.height]);
    expect(saved.sources[0].revision).toBe(afterRefreshScene.revision);
    const bytes = await (await page.request.get(`${origin}/api/world/${fork.session_id}/views/${saved.id}/render`)).body();
    expect(new Set(await sharp(bytes).ensureAlpha().raw().toBuffer()).size).toBeGreaterThan(10);
  }
  expect(await db.collection("place_views").countDocuments({ session_id: fork.session_id })).toBe(6);
  const refreshedForkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${fork.session_id}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const refreshedFork = await (await refreshedForkResponse).json();
  await expect(page.getByRole("button", { name: "Fork world", exact: true })).toBeEnabled(); await ready();
  const forkedRefresh = (await db.collection("place_views").findOne({ session_id: refreshedFork.session_id, id: freshView.id }))!;
  expect(forkedRefresh.refreshed_from).toBe(savedOrbit.id); expect(forkedRefresh.camera).toEqual(orbitCapture.camera);
  await viewPanel.getByLabel("Saved camera view", { exact: true }).selectOption(freshView.id);
  await expect(viewPanel.getByLabel("Saved camera view", { exact: true })).toHaveValue(freshView.id);
  await expect.poll(async () => new URL((await viewPanel.getByRole("img", { name: `${freshView.label} render pass`, exact: true }).getAttribute("src"))!, origin).href).toBe(`${origin}/api/world/${refreshedFork.session_id}/views/${freshView.id}/render`);
  await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
  const refreshedExport = await page.request.get(`${origin}/api/export/session/${refreshedFork.session_id}`);
  expect(refreshedExport.ok()).toBe(true);
  const refreshedZip = await JSZip.loadAsync(await refreshedExport.body());
  const refreshManifest = JSON.parse(await refreshedZip.file("place-views.json")!.async("string"));
  expect(refreshManifest.find((v: { id: string }) => v.id === freshView.id)).toMatchObject({ refreshed_from: savedOrbit.id, historical: false, camera: orbitCapture.camera });
  expect(refreshManifest.find((v: { id: string }) => v.id === savedOrbit.id)).toMatchObject({ historical: true, accepted_illustration_id: regionAsset.id });
  const protectedExport = refreshManifest.find((v: { id: string }) => v.id === freshView.id);
  expect(protectedExport.accepted_illustration_id).toBe(protectedAsset.id);
  const exportedRefresh = protectedExport.illustrations.find((a: { id: string }) => a.id === protectedAsset.id);
  expect(exportedRefresh).toMatchObject({ geometry_refresh: protectedAsset.geometry_refresh, accepted: true, historical: false });
  expect(await refreshedZip.file(exportedRefresh.file)!.async("nodebuffer")).toEqual(protectedBytes);
  const sourceBytes = await refreshedExport.body();
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: "Import World", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "Import World", exact: true });
  const inspection = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/creator/imports");
  await importDialog.getByLabel("World archive").setInputFiles({ name: "saved-world.zip", mimeType: "application/zip", buffer: sourceBytes });
  const inspectedResponse = await inspection;
  expect(inspectedResponse.status(), await inspectedResponse.text()).toBe(200);
  const importPreview = await inspectedResponse.json(), importSid = importPreview.session_id;
  expect(importPreview.status).toBe("preview");
  expect(await db.collection("session_owners").countDocuments({ _id: importSid })).toBe(0);
  await expect(importDialog.getByRole("button", { name: "Import as private world", exact: true })).toBeVisible();
  await importDialog.screenshot({ path: `test-results/world-import-preview-${width}.png` });
  const importEndpoint = `/api/creator/imports/${importPreview.request_id}`;
  await db.command({ collMod: "illustration_assets", validator: { session_id: { $ne: importSid } }, validationLevel: "strict", validationAction: "error" });
  try {
    const failed = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === importEndpoint);
    await importDialog.getByRole("button", { name: "Import as private world", exact: true }).click();
    expect((await failed).status()).toBe(503);
    await expect(importDialog.getByRole("alert")).toBeVisible();
    for (const collection of ["place_scenes", "place_scene_versions", "place_views", "mesh_assets", "illustration_assets"]) expect(await db.collection(collection).countDocuments({ session_id: importSid })).toBe(0);
    expect(await db.collection("session_owners").countDocuments({ _id: importSid })).toBe(0);
  } finally { await db.command({ collMod: "illustration_assets", validator: {} }); }
  let lostImportAck = true;
  await page.route(`**${importEndpoint}`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    if (lostImportAck && response.ok()) { lostImportAck = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await importDialog.getByRole("button", { name: "Import as private world", exact: true }).click();
  await expect(importDialog.getByRole("alert")).toBeVisible();
  await importDialog.getByRole("button", { name: "Import as private world", exact: true }).click();
  await expect(importDialog.getByRole("status")).toHaveText("Private world saved");
  await page.unroute(`**${importEndpoint}`);
  expect(await db.collection("session_owners").countDocuments({ _id: importSid })).toBe(1);
  expect(await db.collection("mesh_jobs").countDocuments({ session_id: importSid })).toBe(0);
  expect(await db.collection("place_build_jobs").countDocuments({ session_id: importSid })).toBe(0);
  expect((await db.collection("creator_worlds").findOne({ _id: importSid }))!.visibility).toBe("private");
  const sourceScene = (await db.collection("place_scenes").findOne({ session_id: refreshedFork.session_id }))!;
  const restoredScene = (await db.collection("place_scenes").findOne({ session_id: importSid }))!;
  expect(restoredScene.definition).toEqual(sourceScene.definition); expect(restoredScene.revision).toBe(sourceScene.revision);
  expect(await (await page.request.get(`${origin}/api/world/${importSid}/illustrations/${protectedAsset.id}`)).body()).toEqual(protectedBytes);
  const importedLibrary = await (await page.request.get(`${origin}/api/world/${importSid}/places/${sourceScene.place_id}/views`)).json();
  expect(importedLibrary.views.find((v: { id: string }) => v.id === freshView.id)).toMatchObject({ historical: false, accepted_illustration_id: protectedAsset.id, camera: orbitCapture.camera });
  await importDialog.getByRole("button", { name: "Done", exact: true }).click();
  await stopApp(); await startApp();
  expect((await page.request.post(`${origin}${importEndpoint}`, { data: { action: "apply", sha256: importPreview.sha256 } })).status()).toBe(200);
  await page.goto(`${origin}/sketch/world?world=${importSid}&place=${sourceScene.place_id}&view=illustration&camera=${freshView.id}`);
  await expect(page.getByRole("region", { name: "Illustration workspace" })).toBeVisible();
  await expect.poll(() => page.getByRole("region", { name: "Illustration workspace" }).locator("img").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/world-import-restored-${width}.png` });
  const secondExport = await page.request.get(`${origin}/api/export/session/${importSid}`); expect(secondExport.status()).toBe(200);
  const restoredZip = await JSZip.loadAsync(await secondExport.body());
  const restoredViews = JSON.parse(await restoredZip.file("place-views.json")!.async("string"));
  expect(restoredViews.find((v: { id: string }) => v.id === freshView.id).capture_metadata).toEqual(refreshManifest.find((v: { id: string }) => v.id === freshView.id).capture_metadata);
  const stranger = await browser.newContext(); try {
    expect((await stranger.request.get(`${origin}/api/export/session/${importSid}`)).status()).toBe(403);
    expect((await stranger.request.get(`${origin}${importEndpoint}`)).status()).toBe(409);
  } finally { await stranger.close(); }
  expect(illustrationSubmissions).toBe(illustrationBefore + 3); illustrationEnabled = false;
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(meshSubmissions).toBeLessThanOrEqual(before + 2); meshEnabled = false;
});
test.afterAll(async () => {
  pending?.destroy();
  for (const child of workers) await stopWorker(child, "SIGKILL");
  await stopApp();
  backend.closeAllConnections(); if (backend.listening) await new Promise<void>(resolve => backend.close(() => resolve()));
  if (originalRouteReference) {
    const generated = await readFile("next-env.d.ts", "utf8");
    const ownReference = '/// <reference path="./test-results/place-build-next/types/routes.d.ts" />';
    if (generated.includes(ownReference)) await writeFile("next-env.d.ts", generated.replace(ownReference, originalRouteReference));
  }
  // This database name is minted by this test and never comes from user config.
  if (client) {
    try {
      if (/^ofb_e2e_[a-f0-9]{24}$/.test(name)) for (const col of await client.db(name).listCollections({}, { nameOnly: true }).toArray()) await client.db(name).collection(col.name).deleteMany({});
    } finally { await client.close(); }
  }
});

for (const width of [1280, 390]) test(`scoped upper floor generation at ${width}`, async ({ page }) => {
  meshEnabled = true; meshReady = true; meshReservation = 2; failStorage = false; materialEnabled = false;
  const before = { layouts: submissions, meshes: meshSubmissions }, errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Component type").selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByLabel("Object name", { exact: true }).fill("Canal archive");
  await page.getByLabel("Building floors", { exact: true }).selectOption("2");
  await page.getByLabel("Floor 2 name", { exact: true }).fill("Reading loft");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, pid = new URL(url).searchParams.get("place")!, db = client.db(name);
  const initial = (await db.collection("place_scenes").findOne({ session_id: sid }))!, building = initial.definition.objects[0];
  const target = { building_id: building.id, floor_id: building.structure.floors[1].id }, endpoint = `${origin}/api/world/${sid}/places/${pid}/build`;
  const panel = page.getByRole("region", { name: "AI place layout", exact: true });
  await panel.getByLabel("Generation scope", { exact: true }).selectOption(target.floor_id);
  await expect(page.getByLabel("Editing floor", { exact: true })).toHaveValue(target.floor_id);
  expect(submissions).toBe(before.layouts); expect(meshSubmissions).toBe(before.meshes);
  await panel.getByLabel("Place description", { exact: true }).fill("TEST FIXTURE - furnish the selected reading loft with a book stand");
  const requests: Record<string, unknown>[] = []; let lose = true;
  await page.route(endpoint, async route => {
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    if (body?.action !== "queue") { await route.continue(); return; }
    requests.push(body);
    if (lose) { lose = false; const res = await route.fetch(); expect(res.status()).toBe(200); await route.abort("failed"); }
    else await route.continue();
  });
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate layout", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry saved request", exact: true })).toBeEnabled();
  await page.getByLabel("Editing floor", { exact: true }).selectOption("");
  await expect(panel.getByLabel("Generation scope", { exact: true })).toHaveValue(target.floor_id);
  await panel.getByRole("button", { name: "Retry saved request", exact: true }).click();
  await expect.poll(() => submissions).toBe(before.layouts + 1);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(lastLayoutInput.target_floor).toEqual(target); expect(lastLayoutInput.definition).toEqual(initial.definition);
  const volume = { ...newComponent("volume", 2, 2), width: 1.2, depth: 1.2, height: 1.5, label: "Fixture book stand", placement: target };
  pending!.end(JSON.stringify({ status: "ready", model: "e2e-fixture-planner", request_id: `scoped_${submissions}`, result: { objects: [volume], meshes: [{ id: "stand", prompt: "TEST FIXTURE - a standalone book stand", role: "prop", targets: [{ object_id: volume.id }] }] } })); pending = undefined;
  const appearance = panel.getByRole("group", { name: "Build appearance", exact: true });
  await appearance.getByRole("button", { name: "Preview layout only", exact: true }).click(); await ready();
  await expect(page.getByLabel("Editing floor", { exact: true })).toHaveValue(target.floor_id);
  await appearance.getByRole("checkbox", { name: "Reserve $2.00 for 1 mesh" }).check();
  await appearance.getByRole("button", { name: "Generate appearance", exact: true }).click();
  await appearance.getByRole("button", { name: "Preview complete appearance", exact: true }).click();
  await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid }))!;
  expect(saved.definition.objects).toHaveLength(2); expect(saved.definition.objects[0]).toEqual(building);
  expect(saved.definition.objects[1]).toMatchObject({ kind: "mesh", mesh_role: "prop", placement: target, x: 2, z: 2, mesh_scale: "uniform" });
  expect(saved.generation_sources[0].target_floor).toEqual(target);
  await page.getByRole("button", { name: "Fixture book stand mesh", exact: true }).click();
  await expect(page.getByLabel("Editing floor", { exact: true })).toHaveValue(target.floor_id);
  await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  const region = page.getByRole("region", { name: "Live 3D", exact: true }), viewport = region.getByTestId("place-viewport");
  await region.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect.poll(() => region.locator("canvas").evaluate(el => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 128; const ctx = canvas.getContext("2d")!;
    ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128); const pixels = ctx.getImageData(0, 0, 128, 128).data; let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1]! > pixels[i]! * 1.4 && pixels[i + 1]! > pixels[i + 2]! * 1.1) n++; return n;
  })).toBeGreaterThan(10);
  const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height * .55, { steps: 15 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
  await page.screenshot({ path: `test-results/scoped-floor-generation-${width}.png` });
  await page.reload(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.definition).toEqual(saved.definition);
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  expect(await zip.file("place-scenes.json")!.async("string")).toContain(target.floor_id);
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json();
  await expect(page.getByRole("button", { name: "Fork world", exact: true })).toBeEnabled(); await ready();
  const forked = (await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!;
  expect(forked.definition).toEqual(saved.definition); expect(forked.generation_sources[0].target_floor).toEqual(target);
  expect(submissions).toBe(before.layouts + 1); expect(meshSubmissions).toBe(before.meshes + 1);
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  meshEnabled = false;
});

for (const width of [1280, 390]) test(`durable surface material workflow at ${width}`, async ({ page, browser }) => {
  materialEnabled = true; materialReady = false; failStorage = true;
  const before = materialSubmissions, errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Component type").selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByLabel("Object name", { exact: true }).fill("Texture workshop");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, db = client.db(name), endpoint = `${origin}/api/world/${sid}/materials`;
  const initial = (await db.collection("place_scenes").findOne({ session_id: sid }))!;
  const panel = page.getByRole("region", { name: "AI material generation", exact: true });
  await panel.getByLabel("Material description", { exact: true }).fill("TEST FIXTURE - material repeat pattern");
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate material", exact: true }).click();
  await expect.poll(async () => !!(await db.collection("material_jobs").findOne({ session_id: sid }))?.request_id).toBe(true);
  const job = (await db.collection("material_jobs").findOne({ session_id: sid }))!;
  await stopWorker(worker, "SIGKILL"); await stopApp();
  await db.collection("material_jobs").updateOne({ session_id: sid }, { $set: { work_until: new Date(Date.now() - 1), next_check: new Date(Date.now() - 1) } });
  materialReady = true; worker = await startWorker();
  await expect.poll(async () => (await db.collection("material_jobs").findOne({ session_id: sid }))?.status).toBe("storage_failed");
  expect(materialSubmissions).toBe(before + 1); expect(await db.collection("material_assets").countDocuments({ session_id: sid })).toBe(0);
  await startApp(); await page.goto(url); await ready();
  await page.getByRole("button", { name: "Texture workshop building", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry material storage", exact: true })).toBeVisible();
  failStorage = false; await panel.getByRole("button", { name: "Retry material storage", exact: true }).click();
  const swatch = page.getByRole("button", { name: "Use material: TEST FIXTURE - material repeat pattern", exact: true });
  await expect(swatch).toBeVisible();
  await expect.poll(() => swatch.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(256);
  await swatch.click(); await page.getByLabel("Material tile size", { exact: true }).fill("1.5");
  await page.getByLabel("Material surface", { exact: true }).selectOption("roof"); await swatch.click();
  await page.getByLabel("Component type").selectOption("path"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByLabel("Object name", { exact: true }).fill("Textured lane");
  await page.getByLabel("Object x", { exact: true }).fill("25");
  await swatch.click(); await page.getByLabel("Material tile size", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Select ground", exact: true }).click();
  await swatch.click(); await page.getByLabel("Material tile size", { exact: true }).fill("4");
  await page.getByLabel("Material rotation", { exact: true }).fill("90");
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid }))!, asset = (await db.collection("material_assets").findOne({ session_id: sid }))!;
  const { materials, ...geometry } = saved.definition.objects[0];
  expect(geometry).toEqual(initial.definition.objects[0]); expect(materials.wall).toMatchObject({ asset_id: asset.id, tile_metres: 1.5 }); expect(materials.roof.asset_id).toBe(asset.id);
  expect(saved.definition.objects.find((o: { kind: string }) => o.kind === "path").materials.floor).toMatchObject({ asset_id: asset.id, tile_metres: 3 });
  expect(saved.definition.ground_material).toMatchObject({ asset_id: asset.id, tile_metres: 4, rotation: Math.PI / 2 });
  await page.getByRole("button", { name: "Texture workshop building", exact: true }).click();
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click(); await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  const region = page.getByRole("region", { name: "Live 3D", exact: true }), viewport = region.getByTestId("place-viewport");
  await region.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect.poll(async () => Number(await viewport.getAttribute("data-textured"))).toBeGreaterThan(0);
  await expect.poll(() => region.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
    const data = ctx.getImageData(0, 0, 128, 128).data; let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! > data[i + 2]! * 1.4 && data[i + 1]! > data[i + 2]! * 1.4) count++; return count;
  })).toBeGreaterThan(50);
  const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .55, { steps: 20 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
  await page.screenshot({ path: `test-results/material-worker-${width}.png` });
  await page.reload(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.definition).toEqual(saved.definition);
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  const manifest = JSON.parse(await zip.file("surface-materials.json")!.async("string"));
  expect(manifest[0]).toMatchObject({ id: asset.id, sha256: asset.sha256, request_id: job.request_id, parameters: materialParameters, image: { channel: "base_color", tiling: "unverified" } });
  expect(await zip.file(manifest[0].file)!.async("nodebuffer")).toEqual(fixtureMaterial());
  const foreign = await browser.newContext(); try { expect((await foreign.request.get(endpoint)).status()).toBe(403); expect((await foreign.request.get(`${endpoint}/${asset.id}`)).status()).toBe(403); } finally { await foreign.close(); }
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition).toEqual(saved.definition);
  expect((await db.collection("material_assets").findOne({ session_id: fork.session_id }))!.sha256).toBe(asset.sha256);
  expect(await db.collection("material_jobs").countDocuments({ session_id: fork.session_id })).toBe(0);
  expect((await (await page.request.get(`${origin}/api/world/${fork.session_id}/materials`)).json()).assets[0].id).toBe(asset.id);
  expect(materialSubmissions).toBe(before + 1); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  materialEnabled = false;
});

for (const withMeshes of [false, true]) for (const width of [1280, 390]) test(`dependent layout and materials${withMeshes ? " and meshes" : ""} workflow at ${width}`, async ({ page, browser }) => {
  materialEnabled = true; materialReady = false; failStorage = false; meshEnabled = withMeshes; meshReady = false;
  meshReservation = withMeshes && width === 1280 ? 5 : 2;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Integrated build fixture ${width}`);
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, pid = new URL(url).searchParams.get("place")!, db = client.db(name);
  const endpoint = `${origin}/api/world/${sid}/places/${pid}/build`, before = materialSubmissions, layouts = submissions, previousMeshes = meshSubmissions;
  const panel = page.getByRole("region", { name: "AI place layout" });
  await panel.getByLabel("Place description", { exact: true }).fill("Two workshops with shared masonry and tiled roofs");
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate layout", exact: true }).click();
  await expect.poll(() => submissions).toBe(layouts + 1); finishPlan(true, withMeshes, true);
  const materials = panel.getByRole("group", { name: "Build materials" }), appearance = panel.getByRole("group", { name: "Build appearance", exact: true });
  await expect(materials.getByText("Materials / 2 proposed", { exact: true })).toBeVisible();
  expect(materialSubmissions).toBe(before); expect(await db.collection("material_jobs").countDocuments({ session_id: sid })).toBe(0);
  await appearance.getByRole("button", { name: "Preview layout only", exact: true }).click();
  await expect(page.getByRole("region", { name: "World change preview" })).toBeVisible(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.definition.objects).toEqual([]);
  await expect(appearance.getByRole("button", { name: "Generate appearance", exact: true })).toBeDisabled();
  if(withMeshes && width===1280){
    await appearance.getByRole("checkbox",{name:"Reserve $10.20 for 2 materials and 2 meshes"}).check();await appearance.getByRole("button",{name:"Generate appearance",exact:true}).click();
    await expect(appearance.getByRole("alert")).toHaveText("Generation spend cap reached");
    for(const collection of ["material_jobs","mesh_jobs","place_build_assets"])expect(await db.collection(collection).countDocuments({session_id:sid})).toBe(0);
    expect((await db.collection("place_build_jobs").findOne({session_id:sid}))!.appearance_approval).toBeUndefined();
    expect(materialSubmissions).toBe(before);expect(meshSubmissions).toBe(previousMeshes);
    meshReservation=2;await panel.getByRole("button",{name:"Refresh layout jobs"}).click();
  }
  const approvals:Record<string,unknown>[]=[];let lose=withMeshes && width===1280;
  await page.route(endpoint,async route=>{
    const body=route.request().method()==="POST"?route.request().postDataJSON():null;
    if(body?.action!=="appearance"){await route.continue();return;}
    approvals.push(body);
    if(lose){lose=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");}else await route.continue();
  });
  await appearance.getByRole("checkbox",{name:withMeshes?"Reserve $4.20 for 2 materials and 2 meshes":"Reserve $0.20 for 2 materials"}).check();
  await appearance.screenshot({ path: `test-results/build-appearance-consent-${withMeshes?"mesh-":""}${width}.png` });
  await appearance.getByRole("button", { name: "Generate appearance", exact: true }).click();
  if(withMeshes&&width===1280){await expect(appearance.getByRole("button",{name:"Retry saved appearance request"})).toBeEnabled();await appearance.getByRole("button",{name:"Retry saved appearance request"}).click();await expect.poll(()=>approvals.length).toBe(2);expect(approvals[0]).toEqual(approvals[1]);}
  await expect.poll(() => materialSubmissions).toBe(before + 2);
  await expect.poll(async () => await db.collection("material_jobs").countDocuments({ session_id: sid, request_id: { $exists: true } })).toBe(2);
  if (withMeshes) {
    await expect.poll(() => meshSubmissions).toBe(previousMeshes + 2);
    await expect.poll(async () => await db.collection("mesh_jobs").countDocuments({ session_id: sid, request_id: { $exists: true } })).toBe(2);
  }
  const build = (await db.collection("place_build_jobs").findOne({ session_id: sid }))!, stage = (await db.collection("place_build_assets").findOne({ session_id: sid, kind: "material" }))!;
  expect(build.appearance_approval).toMatchObject({id:approvals[0]!.request_id,kinds:withMeshes?["material","mesh"]:["material"],total_reservation:withMeshes?4.2:0.2});
  expect(stage.items).toHaveLength(2); expect(stage.reservation).toBeCloseTo(0.2);
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.definition.objects).toEqual([]);
  await stopWorker(worker, "SIGKILL"); await page.goto("about:blank"); await stopApp();
  await db.collection("material_jobs").updateMany({ session_id: sid }, { $set: { work_until: new Date(Date.now() - 1), next_check: new Date(Date.now() - 1) } });
  if (withMeshes) await db.collection("mesh_jobs").updateMany({ session_id: sid }, { $set: { work_until: new Date(Date.now() - 1), next_check: new Date(Date.now() - 1) } });
  materialReady = true; meshReady = true; worker = await startWorker();
  await expect.poll(async () => await db.collection("material_jobs").countDocuments({ session_id: sid, status: "ready" })).toBe(2);
  if (withMeshes) await expect.poll(async () => await db.collection("mesh_jobs").countDocuments({ session_id: sid, status: "ready" })).toBe(2);
  expect(materialSubmissions).toBe(before + 2);
  await startApp(); await page.goto(url); await ready();
  await appearance.getByRole("button", { name: "Preview complete appearance", exact: true }).click();
  await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid }))!;
  expect(saved.definition.objects.slice(0, 2).map(({ materials: _materials, ...o }: { materials?: unknown }) => o)).toEqual(build.result.objects.slice(0, 2));
  if (withMeshes) {
    expect(saved.definition.objects.map((o: { id: string }) => o.id)).toEqual(build.result.objects.map((o: { id: string }) => o.id));
    expect(saved.definition.objects[2]).toMatchObject({ kind: "mesh", mesh_role: "exterior", mesh_scale: "uniform", width: 3, height: 6, depth: 4.5, x: 28, z: 30 });
    expect(saved.definition.objects[2].structure).toBeUndefined();
    expect(saved.definition.objects[3]).toMatchObject({ kind: "mesh", mesh_role: "prop", mesh_scale: "uniform", width: 0.4, height: 0.8, placement: build.result.objects[3].placement, x: 1.8, z: 1.5 });
  }
  expect(saved.definition.objects[0].materials).toEqual(saved.definition.objects[1].materials);
  expect(Object.keys(saved.definition.objects[0].materials)).toEqual(["wall", "roof"]);
  expect(saved.definition.ground_material).toMatchObject({ asset_id: saved.definition.objects[0].materials.wall.asset_id, tile_metres: 3 });
  expect(saved.definition.objects.find((o: { kind: string }) => o.kind === "path").materials.floor).toEqual(saved.definition.ground_material);
  await page.getByRole("button", { name: "North workshop building", exact: true }).click();
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click(); await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  const region = page.getByRole("region", { name: "Live 3D", exact: true }), viewport = region.getByTestId("place-viewport");
  await region.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect.poll(async () => Number(await viewport.getAttribute("data-textured"))).toBeGreaterThan(0);
  await expect.poll(() => region.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
    const pixels = ctx.getImageData(0, 0, 128, 128).data; let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > pixels[i + 2]! * 1.4 && pixels[i + 1]! > pixels[i + 2]! * 1.4) n++; return n;
  })).toBeGreaterThan(50);
  const camera = await viewport.getAttribute("data-camera"), rect = (await region.locator("canvas").boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .55, { steps: 20 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("data-camera")).not.toBe(camera);
  await page.screenshot({ path: `test-results/build-materials-applied-${width}.png` });
  if (withMeshes) for (const label of ["Stone monument", "Room furnishing"]) {
    await page.getByRole("button", { name: `${label} mesh`, exact: true }).click();
    await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click(); await region.scrollIntoViewIfNeeded();
    await expect(viewport).toHaveAttribute("data-ready", "true");
    await expect.poll(() => region.locator("canvas").evaluate(el => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
      const data = ctx.getImageData(0, 0, 128, 128).data; let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 1]! > data[i]! * 1.3 && data[i + 1]! > data[i + 2]! * 1.1) n++; return n;
    })).toBeGreaterThan(50);
    await page.screenshot({ path: `test-results/build-${label.replaceAll(" ", "-")}-${width}.png` });
  }
  await page.reload(); await ready(); expect(materialSubmissions).toBe(before + 2); expect(submissions).toBe(layouts + 1);
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  const manifest = JSON.parse(await zip.file("surface-materials.json")!.async("string")); expect(manifest).toHaveLength(2);
  for (const asset of manifest) { expect(asset.dependency).toMatchObject({ build_key: build._id, revision: 1, result_sha256: stage.result_sha256, plan_sha256: stage.plan_sha256 }); expect(await zip.file(asset.file)!.async("nodebuffer")).toEqual(fixtureMaterial()); }
  if (withMeshes) {
    const meshManifest = JSON.parse(await zip.file("mesh-assets.json")!.async("string")); expect(meshManifest).toHaveLength(2);
    for (const asset of meshManifest) { expect(asset.dependency).toMatchObject({ kind: "mesh", build_key: build._id, revision: 1, result_sha256: stage.result_sha256 }); expect(await zip.file(asset.file)!.async("nodebuffer")).toEqual(fixtureGlb()); }
  }
  const foreign = await browser.newContext(); try { expect((await foreign.request.get(endpoint)).status()).toBe(403); } finally { await foreign.close(); }
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.definition).toEqual(saved.definition);
  expect(await db.collection("material_jobs").countDocuments({ session_id: fork.session_id })).toBe(0);
  expect(await db.collection("mesh_jobs").countDocuments({ session_id: fork.session_id })).toBe(0);
  if (withMeshes) expect((await db.collection("mesh_assets").findOne({ session_id: fork.session_id }))!.dependency.build_key).toBe(build._id);
  expect(await db.collection("place_build_assets").countDocuments({ session_id: fork.session_id })).toBe(0);
  expect((await db.collection("material_assets").findOne({ session_id: fork.session_id }))!.dependency.build_key).toBe(build._id);
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(materialSubmissions).toBe(before + 2); expect(submissions).toBe(layouts + 1); expect(meshSubmissions).toBe(previousMeshes + (withMeshes ? 2 : 0)); materialEnabled = false; meshEnabled = false;
});

for (const width of [1280, 390]) test(`explore to adjoining generation at ${width}`, async ({ page }) => {
  test.setTimeout(180_000);
  materialEnabled = true; meshEnabled = true; materialReady = true; meshReady = true; meshReservation = 2;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const before = submissions, assetsBefore = [meshSubmissions, materialSubmissions, illustrationSubmissions];
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Expansion fixture ${width}`);
  await page.getByRole("combobox", { name: "Component type" }).selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByLabel("Object name", { exact: true }).fill("Original guild hall");
  await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("38"); await page.getByLabel("Entrance z", { exact: true }).fill("20");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const sourceUrl = page.url(), sid = new URL(sourceUrl).searchParams.get("world")!, pid = new URL(sourceUrl).searchParams.get("place")!, db = client.db(name);
  const original = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
  expect(original!.definition.objects).toHaveLength(1);
  await page.getByText("Add adjoining area", { exact: true }).click(); await page.getByLabel("Adjoining area name").fill("New workshop yard");
  await page.getByRole("button", { name: "Preview adjoining area", exact: true }).click();
  await page.getByRole("checkbox", { name: "Generate layout in new area" }).check();
  await page.getByLabel("Adjoining area description").fill("TEST FIXTURE - two workshops beyond the east boundary");
  await expect(page.getByRole("button", { name: "Create and generate", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only" }).check();
  await page.locator("details").filter({ has: page.getByLabel("Adjoining area name") }).screenshot({ path: `test-results/adjoining-generation-controls-${width}.png` });
  const requests: Record<string, unknown>[] = []; let lost = width === 1280;
  const endpoint = `${origin}/api/world/${sid}/places/${pid}/connections`;
  await page.route(endpoint, async route => {
    const body = route.request().postDataJSON();
    if (body?.action !== "generate") { await route.continue(); return; }
    requests.push(body);
    if (lost) { lost = false; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("region", { name: "Connection preview" }).screenshot({ path: `test-results/adjoining-generation-review-${width}.png` });
  await page.getByRole("button", { name: "Create and generate", exact: true }).click();
  if (width === 1280) { await expect(page.getByRole("button", { name: "Retry saved expansion", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Retry saved expansion", exact: true }).click(); expect(requests[1]).toEqual(requests[0]); }
  await expect(page).not.toHaveURL(sourceUrl); await ready();
  const newUrl = page.url(), newPid = new URL(newUrl).searchParams.get("place")!; expect(newPid).not.toBe(pid);
  await expect.poll(() => submissions).toBe(before + 1);
  expect(lastLayoutInput.connection_input).toMatchObject({ place_id: newPid, connections: [{ a: { place_id: pid, side: "east" }, b: { place_id: newPid, side: "west" } }] });
  expect(await db.collection("place_scenes").countDocuments({ session_id: sid })).toBe(2); expect(await db.collection("place_connections").countDocuments({ session_id: sid })).toBe(1);
  expect(await db.collection("place_build_jobs").countDocuments({ session_id: sid })).toBe(1);
  await page.reload(); await ready(); expect(submissions).toBe(before + 1); finishPlan(true,true);
  const panel = page.getByRole("region", { name: "AI place layout" }); await panel.getByRole("button", { name: "Refresh layout jobs" }).click();
  const appearance=panel.getByRole("group",{name:"Build appearance",exact:true});
  await appearance.getByRole("checkbox",{name:"Reserve $4.20 for 2 materials and 2 meshes"}).check();await appearance.getByRole("button",{name:"Generate appearance",exact:true}).click();
  await expect(appearance.getByRole("button",{name:"Preview complete appearance",exact:true})).toBeEnabled();
  await appearance.getByRole("button",{name:"Preview complete appearance",exact:true}).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid, place_id: newPid }))!; expect(saved.definition.objects).toHaveLength(4);
  expect(saved.definition.objects.filter((o:{materials?:unknown})=>o.materials)).toHaveLength(2);expect(saved.definition.objects.filter((o:{kind:string})=>o.kind==="mesh")).toHaveLength(2);
  expect(saved.generation_sources[0].connection_input.connections).toHaveLength(1);
  expect(await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid })).toEqual(original);
  const replay = await page.request.post(endpoint, { data: requests[0] }); expect(replay.status()).toBe(200); expect((await replay.json()).job.status).toBe("ready");
  expect(await db.collection("place_scenes").findOne({ session_id: sid, place_id: newPid })).toEqual(saved);
  await page.getByLabel("Connected place", { exact: true }).selectOption(pid); await ready();
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); const viewport = page.getByTestId("place-viewport"); await viewport.scrollIntoViewIfNeeded();
  await expect(viewport).toHaveAttribute("data-loaded-places", "2"); const canvas = await viewport.locator("canvas").elementHandle();
  if(width===390){
    const touch=await page.context().newCDPSession(page);
    const hold=async(label:string,target:string,cancel=false)=>{
      const button=page.getByRole("button",{name:label,exact:true});await button.scrollIntoViewIfNeeded();const box=(await button.boundingBox())!;
      await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,id:1}]});
      try{await expect(viewport).toHaveAttribute("data-place-id",target);}finally{await touch.send("Input.dispatchTouchEvent",{type:cancel?"touchCancel":"touchEnd",touchPoints:[]});}
      const pose=await viewport.getAttribute("data-camera");await page.waitForTimeout(300);expect(await viewport.getAttribute("data-camera")).toBe(pose);
    };
    try{await hold("Strafe right",newPid);await hold("Strafe left",pid,true);await hold("Strafe right",newPid);}finally{await touch.detach();}
  }else{await page.keyboard.down("d");try{await expect(viewport).toHaveAttribute("data-place-id",newPid);}finally{await page.keyboard.up("d");}}
  expect(await viewport.locator("canvas").evaluate((node, original) => node === original, canvas)).toBe(true);
  await expect.poll(async () => (await db.collection("creator_worlds").findOne({ _id: sid as never }))?.walk_position?.pose?.place_id).toBe(newPid);
  const connectedExport = await page.request.get(`${origin}/api/export/session/${sid}`); expect(connectedExport.status()).toBe(200);
  const connectedBytes = await connectedExport.body();
  await page.keyboard.down("ArrowRight"); try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw"))).toBeLessThan(-0.6); } finally { await page.keyboard.up("ArrowRight"); }
  const range = await viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data; let low = 255, high = 0; for (let i = 0; i < pixels.length; i += 4) { low = Math.min(low, pixels[i]!); high = Math.max(high, pixels[i]!); } return high - low;
  }); expect(range).toBeGreaterThan(40); await viewport.screenshot({ path: `test-results/adjoining-generation-walk-${width}.png` });
  await page.goto(newUrl); await ready(); expect(submissions).toBe(before + 1); expect([meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual([assetsBefore[0]!+2,assetsBefore[1]!+2,assetsBefore[2]]);
  const restoredSid = await importThroughLibrary(page, connectedBytes);
  const restoredScenes = await db.collection("place_scenes").find({ session_id: restoredSid }).sort({ place_id: 1 }).toArray();
  const sourceScenes = await db.collection("place_scenes").find({ session_id: sid }).sort({ place_id: 1 }).toArray();
  expect(restoredScenes.map(s => s.definition)).toEqual(sourceScenes.map(s => s.definition));
  expect(await db.collection("place_connections").countDocuments({ session_id: restoredSid })).toBe(1);
  for (const collection of ["mesh_assets", "material_assets"]) {
    const assets = await db.collection(collection).find({ session_id: restoredSid }).toArray(); expect(assets).toHaveLength(2);
    for (const asset of assets) {
      const source = (await db.collection(collection).findOne({ session_id: sid, id: asset.id }))!;
      expect(asset.key).not.toBe(source.key); expect(blobs.get(asset.key)).toEqual(blobs.get(source.key));
    }
  }
  await stopApp(); await startApp();
  await page.goto(`${origin}/sketch/world?world=${restoredSid}&place=${pid}&view=walk`); await ready();
  await expect(viewport).toHaveAttribute("data-loaded-places", "2");
  await expect(viewport).toHaveAttribute("data-pose-restore", "restored"); await expect(viewport).toHaveAttribute("data-place-id", newPid);
  await viewport.scrollIntoViewIfNeeded();
  await page.keyboard.down("a"); try { await expect(viewport).toHaveAttribute("data-place-id", pid); } finally { await page.keyboard.up("a"); }
  await page.keyboard.down("d"); try { await expect(viewport).toHaveAttribute("data-place-id", newPid); } finally { await page.keyboard.up("d"); }
  await viewport.screenshot({ path: `test-results/world-import-connected-${width}.png` });
  expect(submissions).toBe(before + 1); expect([meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual([assetsBefore[0]!+2,assetsBefore[1]!+2,assetsBefore[2]]);
  for (const collection of ["mesh_jobs", "material_jobs", "place_build_jobs"]) expect(await db.collection(collection).countDocuments({ session_id: restoredSid })).toBe(0);
  materialEnabled=false;meshEnabled=false;
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1280, 390]) test(`connected layout preserves saved openings at ${width}`, async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const before = submissions, assetsBefore = [meshSubmissions, materialSubmissions, illustrationSubmissions];
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Connected layout fixture ${width}`);
  await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("38"); await page.getByLabel("Entrance z", { exact: true }).fill("20");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, pid = new URL(url).searchParams.get("place")!, db = client.db(name);
  const addNeighbor = async (side: "east" | "north") => {
    const toggle = page.getByText("Add adjoining area", { exact: true }); if (!await page.getByLabel("Adjoining area name").isVisible()) await toggle.click();
    await page.getByLabel("Adjoining area name").fill(`Unbuilt ${side} yard`); await page.getByRole("button", { name: `Expand ${side}`, exact: true }).click();
    await page.getByRole("button", { name: "Preview adjoining area", exact: true }).click(); await page.getByRole("button", { name: "Apply adjoining area", exact: true }).click();
    await expect(page.getByLabel("Connected place", { exact: true })).toBeVisible(); await ready();
  };
  await addNeighbor("east");
  const links = () => db.collection("place_connections").find({ session_id: sid }).toArray();
  const east = (await links())[0]!, neighbor = await db.collection("place_scenes").findOne({ session_id: sid, place_id: east.b.place_id });
  const rootBefore = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
  const panel = page.getByRole("region", { name: "AI place layout" });
  const generate = async (label: string, count: number) => {
    await panel.getByLabel("Place description", { exact: true }).fill(label); await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate layout", exact: true }).click();
    await expect.poll(() => submissions).toBe(before + count);
    const input = lastLayoutInput.connection_input as { place_id: string; connections: { id: string }[] };
    expect(input.place_id).toBe(pid); expect(input.connections.map(c => c.id).sort()).toEqual((await links()).map(c => c.id).sort());
  };
  await generate("TEST FIXTURE - blocked east opening", 1);
  pending!.end(JSON.stringify({ status: "ready", model: "e2e-fixture-planner", request_id: `fixture_${submissions}`, result: { objects: [{ ...newComponent("wall", 39.5, 20), width: 0.8, depth: 0.8 }] } })); pending = undefined;
  await expect(panel.getByText(/Connection approach is blocked/)).toBeVisible();
  expect(await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid })).toEqual(rootBefore);
  await generate("TEST FIXTURE - initially connected workshops", 2); finishPlan();
  await expect(panel.getByRole("button", { name: "Preview generated layout", exact: true })).toBeEnabled();
  await addNeighbor("north"); await panel.getByRole("button", { name: "Refresh layout jobs", exact: true }).click();
  await expect(panel.getByText("Saved connections changed; a new layout request is required.").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Preview generated layout", exact: true })).toBeDisabled();
  expect((await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid }))!.revision).toBe(1);
  await panel.screenshot({ path: `test-results/connected-layout-stale-${width}.png` });
  await generate("TEST FIXTURE - workshops with both saved approaches", 3); finishPlan();
  const preview = panel.getByRole("button", { name: "Preview generated layout", exact: true }).and(page.locator("button:enabled"));
  await expect(preview).toHaveCount(1); await preview.click();
  await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid }))!;
  expect(saved.definition.objects).toHaveLength(2); expect(saved.generation_sources[0].connection_input.connections).toHaveLength(2);
  expect(saved.generation_sources[0].connections_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await db.collection("place_scenes").findOne({ session_id: sid, place_id: east.b.place_id })).toEqual(neighbor);
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); const viewport = page.getByTestId("place-viewport"); await viewport.scrollIntoViewIfNeeded();
  await expect(viewport).toHaveAttribute("data-loaded-places", "3");
  const canvas = await viewport.locator("canvas").elementHandle();
  await page.keyboard.down("d"); try { await expect(viewport).toHaveAttribute("data-place-id", east.b.place_id); } finally { await page.keyboard.up("d"); }
  expect(await viewport.locator("canvas").evaluate((node, original) => node === original, canvas)).toBe(true);
  await page.keyboard.down("a"); try { await expect(viewport).toHaveAttribute("data-place-id", pid); } finally { await page.keyboard.up("a"); }
  await page.keyboard.down("ArrowLeft"); try { await expect.poll(async () => Number(await viewport.getAttribute("data-yaw"))).toBeGreaterThan(1.05); } finally { await page.keyboard.up("ArrowLeft"); }
  const range = await viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data; let low = 255, high = 0;
    for (let i = 0; i < pixels.length; i += 4) { low = Math.min(low, pixels[i]!); high = Math.max(high, pixels[i]!); } return high - low;
  }); expect(range).toBeGreaterThan(40);
  await viewport.screenshot({ path: `test-results/connected-layout-walk-${width}.png` });
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  const exported = JSON.parse(await zip.file("place-scenes.json")!.async("string")); expect(exported.find((s: { place_id: string; revision: number }) => s.place_id === pid && s.revision === 2).generation_sources).toEqual(saved.generation_sources);
  await page.goto(url); await ready(); expect(submissions).toBe(before + 3); expect([meshSubmissions, materialSubmissions, illustrationSubmissions]).toEqual(assetsBefore);
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1280, 390]) test(`durable generated-layout workflow at ${width}`, async ({ page, browser }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/sketch/world`);
  const ready = () => expect(page.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true"); await ready();
  await page.getByLabel("Place name", { exact: true }).fill(`Build fixture ${width}`);
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page).toHaveURL(/world=session_/); await ready();
  const url = page.url(), sid = new URL(url).searchParams.get("world")!, pid = new URL(url).searchParams.get("place")!, db = client.db(name);
  const endpoint = `${origin}/api/world/${sid}/places/${pid}/build`;
  const before = submissions;
  const panel = page.getByRole("region", { name: "AI place layout" });
  await panel.getByLabel("Place description", { exact: true }).fill("Two workshops with an accessible upper floor");
  await expect(panel.getByRole("button", { name: "Generate layout", exact: true })).toBeDisabled();
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "Generate layout", exact: true }).click();
  await expect.poll(() => submissions).toBe(before + 1);
  const running = (await db.collection("place_build_jobs").findOne({ session_id: sid }))!;
  const duplicateRuns = await Promise.all([page.request.post(endpoint, { data: { action: "run", id: running.id } }), page.request.post(endpoint, { data: { action: "run", id: running.id } })]);
  expect(duplicateRuns.every(r => r.ok())).toBe(true); expect(submissions).toBe(before + 1);
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.definition.objects).toEqual([]);
  await page.reload(); await ready();
  await expect(panel.getByText("planning", { exact: true })).toBeVisible();
  // Completion happens while there is NO web process or browser page alive.
  await page.goto("about:blank"); await stopApp();
  if (width === 390) {
    const draining = stopWorker(worker);
    finishPlan(); await draining;
    worker = await startWorker();
  } else finishPlan();
  await expect.poll(async () => (await db.collection("place_build_jobs").findOne({ session_id: sid }))?.status).toBe("ready");
  await startApp(); await page.goto(url); await ready();
  await expect(panel.getByRole("button", { name: "Preview generated layout", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Preview generated layout", exact: true }).click();
  await expect(page.getByRole("region", { name: "World change preview" })).toBeVisible();
  expect((await db.collection("place_scenes").findOne({ session_id: sid }))!.revision).toBe(1);
  await page.getByLabel("Place name", { exact: true }).fill(`Reviewed layout ${width}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved"); await ready();
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid }))!;
  expect(saved.definition.objects).toHaveLength(2); expect(saved.generation_sources).toHaveLength(1);
  expect(saved.generation_sources[0]).toMatchObject({ model: "e2e-fixture-planner", prompt: "Two workshops with an accessible upper floor", base_revision: 1, object_ids: saved.definition.objects.map((o: { id: string }) => o.id) });
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).click();
  for (const canvas of await page.getByTestId("place-viewport").all()) await expect(canvas).toHaveAttribute("data-ready", "true");
  await page.getByRole("region", { name: "Live 3D" }).scrollIntoViewIfNeeded();
  const range = await page.getByRole("region", { name: "Live 3D" }).locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data; let min = 255, max = 0; for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i]!); max = Math.max(max, data[i]!); } return max - min;
  }); expect(range).toBeGreaterThan(30);
  await page.screenshot({ path: `test-results/place-build-${width}.png` });
  await page.reload(); await ready(); expect(submissions).toBe(before + 1);
  const zip = await JSZip.loadAsync(await (await page.request.get(`${origin}/api/export/session/${sid}`)).body());
  const exported = JSON.parse(await zip.file("place-scenes.json")!.async("string")); expect(exported.find((s: { revision: number }) => s.revision === 2).generation_sources).toEqual(saved.generation_sources);
  const job = (await db.collection("place_build_jobs").findOne({ session_id: sid }))!;
  expect((await page.request.post(endpoint, { data: { action: "run", id: job.id } })).status()).toBe(200); expect(submissions).toBe(before + 1);
  expect((await page.request.post(endpoint, { data: { action: "preview", id: job.id } })).status()).toBe(409);
  const newId = crypto.randomUUID(), queued = { action: "queue", id: newId, prompt: "A courtyard", model: "e2e-fixture-planner", confirmed: true, reservation: 0.2, base_revision: 2 };
  const [a, b] = await Promise.all([page.request.post(endpoint, { data: queued }), page.request.post(endpoint, { data: queued })]); expect(a!.ok() && b!.ok()).toBe(true);
  await page.goto("about:blank"); await stopApp(); await startApp(); await page.goto(url); await ready();
  const restored = await (await page.request.get(endpoint)).json();
  expect(restored.jobs.find((j: { id: string }) => j.id === newId).status).toBe("queued");
  expect(restored.jobs.find((j: { id: string }) => j.id === job.id).status).toBe("ready"); expect(submissions).toBe(before + 1);
  await page.request.post(endpoint, { data: { action: "cancel", id: newId } }); await page.request.post(endpoint, { data: { action: "cancel", id: newId } });
  expect((await db.collection("spend_ledger").findOne({ _id: `sess:${sid}:${new Date().toISOString().slice(0, 10)}` as never }))!.total).toBeCloseTo(0.2);
  const foreign = await browser.newContext(); try { expect((await foreign.request.get(endpoint)).status()).toBe(403); } finally { await foreign.close(); }
  const forkResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
  await page.getByRole("button", { name: "Fork world", exact: true }).click(); const fork = await (await forkResponse).json(); await ready();
  expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id }))!.generation_sources).toEqual(saved.generation_sources);
  expect(submissions).toBe(before + 1); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 1280) {
    // Reconstruct the deterministic crash boundary from the response this
    // worker actually saved. This is a recovery fixture, not a model-quality claim.
    await stopWorker(worker);
    await db.collection("place_build_jobs").updateOne({ session_id: sid, id: job.id }, { $set: { status: "validating" }, $unset: { result: "", receipt: "" } });
    worker = await startWorker();
    await expect.poll(async () => (await db.collection("place_build_jobs").findOne({ session_id: sid, id: job.id }))?.status).toBe("ready");
    expect(submissions).toBe(before + 1);

    const restartId = crypto.randomUUID();
    expect((await page.request.post(endpoint, { data: { ...queued, id: restartId } })).ok()).toBe(true);
    await stopWorker(worker);
    expect((await page.request.post(endpoint, { data: { action: "run", id: restartId } })).ok()).toBe(true);
    expect((await db.collection("place_build_jobs").findOne({ session_id: sid, id: restartId }))!.status).toBe("scheduled");
    worker = await startWorker(); const competitor = await startWorker();
    await expect.poll(() => submissions).toBe(before + 2);
    const executing = (await db.collection("place_build_jobs").findOne({ session_id: sid, id: restartId }))!;
    expect(executing.submission_started_at).toBeInstanceOf(Date);
    // Both workers are killed, leaving a genuine interrupted request. Expiry is
    // accelerated in this test-owned database instead of waiting three minutes.
    await stopWorker(worker, "SIGKILL"); await stopWorker(competitor, "SIGKILL"); pending?.destroy(); pending = undefined;
    await db.collection("place_build_jobs").updateOne({ session_id: sid, id: restartId }, { $set: { deadline: new Date(Date.now() - 1) } });
    worker = await startWorker();
    await expect.poll(async () => (await db.collection("place_build_jobs").findOne({ session_id: sid, id: restartId }))?.status).toBe("submission_unknown");
    expect((await page.request.post(endpoint, { data: { action: "run", id: restartId } })).ok()).toBe(true);
    await page.request.get(endpoint);
    await expect.poll(async () => (await db.collection("generation_workers").findOne({ last_seen: { $gt: new Date(Date.now() - 1000) } })) !== null, { intervals: [1000], timeout: 10_000 }).toBe(true);
    expect(submissions).toBe(before + 2);
    expect((await page.request.post(endpoint, { data: { action: "cancel", id: restartId } })).ok()).toBe(true);
    expect((await db.collection("spend_ledger").findOne({ _id: `sess:${sid}:${new Date().toISOString().slice(0, 10)}` as never }))!.total).toBeCloseTo(0.4);
  }
});
