import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";
import JSZip from "jszip";
import { fixtureTexturedGlb } from "./fixtures/mesh-glb";
import { fixtureMaterial } from "./fixtures/material-jpeg";
import { waitForStableImage } from "./helpers";

test.skip(process.env.E2E_SELFHOST !== "1", "Run scripts/selfhost/check.mjs for an isolated, credential-free production stack");
test.describe.configure({ mode: "serial" });
const recording = process.env.E2E_SELFHOST_VIDEO === "1";
test.use(recording ? { video: { mode: "on", size: { width: 1280, height: 900 } }, viewport: { width: 1280, height: 900 }, launchOptions: { slowMo: 180 } } : {});
let client: MongoClient;
let receipt: { project: string; compose_file: string; origin: string; mongo: string; database: string; fixture_providers: boolean };
const exec = promisify(execFile);
test.beforeAll(async ({ request, baseURL }) => {
  receipt = JSON.parse(await readFile(process.env.E2E_SELFHOST_RECEIPT!, "utf8"));
  if (!/^ofb-check-[a-f0-9]{12}$/.test(receipt.project) || receipt.origin !== baseURL || !receipt.fixture_providers
    || new URL(receipt.mongo).hostname !== "127.0.0.1" || receipt.database !== "selfhost_check") throw new Error("Expected an isolated self-host receipt");
  await expect.poll(async () => { try { return (await request.get("/api/status")).status(); } catch { return 0; } }, { timeout: 120_000 }).toBe(200);
  client = new MongoClient(receipt.mongo); await client.connect();
  const db = client.db(receipt.database);
  expect(await db.collection("nodes").countDocuments()).toBe(0);
  expect(await db.collection("place_scenes").countDocuments()).toBe(0);
  await expect.poll(() => db.collection("generation_workers").countDocuments({ mesh: true, last_seen: { $gt: new Date(Date.now() - 30000) } })).toBe(1);
});
test.afterAll(async () => { await client?.close(); });

test("image-first mock generation saves a real page in fresh local stores", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("SELF-HOST MOCK - a small harbor town"));
  await waitForStableImage(page);
  await expect.poll(() => client.db(receipt.database).collection("nodes").countDocuments()).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("image-first-mock.png") });
});

for (const width of [1280, 390]) test(`production world create, edit, mesh, restart and restore at ${width}`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const db = client.db(receipt.database), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto("/");
  await page.getByRole("link", { name: "New 3D World", exact: true }).click();
  const viewport = page.getByTestId("place-viewport"), ready = async () => {
    await expect(viewport.first()).toHaveAttribute("data-ready", "true");
    for (const canvas of await viewport.all()) await expect(canvas).toHaveAttribute("data-ready", "true");
  }; await ready();
  const save = async (revision: number) => {
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready();
  };
  await page.getByLabel("Place name", { exact: true }).fill(`Self-host district ${width}`);
  await page.getByRole("combobox", { name: "Component type" }).selectOption("building");
  await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("2");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await save(1);
  const sid = new URL(page.url()).searchParams.get("world")!, pid = new URL(page.url()).searchParams.get("place")!;
  const panel = page.getByRole("region", { name: "AI 3D generation" });
  await panel.getByRole("button", { name: "Import", exact: true }).click();
  const meshBytes = fixtureTexturedGlb(fixtureMaterial(), source => { source.images![0]!.mimeType = "image/jpeg"; });
  await panel.getByLabel("GLB file").setInputFiles({ name: "Textured fixture.glb", mimeType: "model/gltf-binary", buffer: meshBytes });
  const upload = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/api/world/${sid}/meshes/import`));
  await panel.getByRole("button", { name: "Import GLB", exact: true }).click();
  const uploaded = await upload; expect(uploaded.status(), await uploaded.text()).toBe(200);
  await panel.getByRole("button", { name: "Place in scene", exact: true }).click();
  await expect(page.getByLabel("Object name", { exact: true })).toHaveValue("Textured fixture.glb"); await ready();
  await page.getByLabel("Object x", { exact: true }).fill("31"); await page.getByLabel("Object z", { exact: true }).fill("31");
  await expect(page.getByLabel("Object x", { exact: true })).toHaveValue("31");
  await expect(page.getByLabel("Object z", { exact: true })).toHaveValue("31");
  await save(2);
  await page.getByRole("button", { name: "Building building", exact: true }).click();
  await page.getByLabel("Object height", { exact: true }).fill("8.6"); await save(3);
  const saved = (await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid }))!;
  expect(saved.definition.objects).toHaveLength(2);
  expect(saved.definition.objects.find((object: { kind: string }) => object.kind === "mesh")).toMatchObject({ x: 31, z: 31, width: 1.5, height: 3, depth: 2.25 });
  expect(saved.definition.objects.find((object: { kind: string }) => object.kind === "building")).toMatchObject({ height: 8.6 });
  await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  const pixelRange = () => viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
    const bytes = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3); return Math.max(...bytes) - Math.min(...bytes);
  });
  const texturePixels = () => viewport.locator("canvas").evaluate(el => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
    const bytes = ctx.getImageData(0, 0, 128, 128).data; let purple = 0, yellow = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const r = bytes[i]!, g = bytes[i + 1]!, b = bytes[i + 2]!;
      if (b > r * 1.2 && r > g * 1.3) purple++;
      if (r > g * 1.1 && g > b * 1.5) yellow++;
    }
    return Math.min(purple, yellow);
  });
  await expect.poll(pixelRange).toBeGreaterThan(30);
  if (recording) await page.waitForTimeout(1200);
  const views = page.getByRole("region", { name: "Saved camera views", exact: true });
  await views.getByLabel("View name", { exact: true }).fill("Production camera");
  await views.getByRole("button", { name: "Save camera view", exact: true }).click();
  await expect(views.getByRole("status").filter({ hasText: /^Current geometry/ })).toBeVisible();
  const exported = await page.request.get(`/api/export/session/${sid}`); expect(exported.status(), await exported.text()).toBe(200);
  const bytes = await exported.body(), zip = await JSZip.loadAsync(bytes);
  const meshes = JSON.parse(await zip.file("mesh-assets.json")!.async("string"));
  expect(await zip.file(meshes[0].file)!.async("nodebuffer")).toEqual(meshBytes);
  await page.goto("/"); await page.getByRole("button", { name: "Import World", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import World", exact: true });
  const inspected = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/creator/imports");
  await dialog.getByLabel("World archive").setInputFiles({ name: "selfhost-world.zip", mimeType: "application/zip", buffer: bytes });
  const response = await inspected; expect(response.status(), await response.text()).toBe(200);
  const preview = await response.json(), restoredSid = preview.session_id;
  await dialog.getByRole("button", { name: "Import as private world", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Private world saved");
  await page.goto("about:blank");
  await exec("docker", ["compose", "--env-file", "/dev/null", "--project-name", receipt.project, "--file", receipt.compose_file, "restart", "web", "place-worker"], { timeout: 120_000 });
  await expect.poll(async () => { try { return (await page.request.get(`${receipt.origin}/api/status`)).status(); } catch { return 0; } }, { timeout: 120_000 }).toBe(200);
  await page.goto(`${receipt.origin}/sketch/world?world=${restoredSid}&place=${pid}`); await ready();
  const restored = (await db.collection("place_scenes").findOne({ session_id: restoredSid, place_id: pid }))!;
  expect(restored.definition).toEqual(saved.definition);
  await page.getByRole("button", { name: "3D", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  await expect.poll(pixelRange).toBeGreaterThan(30);
  await page.screenshot({ path: test.info().outputPath(`restored-${width}.png`) });
  const importedMesh = saved.definition.objects.find((object: { kind: string }) => object.kind === "mesh");
  await page.getByRole("button", { name: `${importedMesh.label} mesh`, exact: true }).click();
  await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  await ready(); await viewport.scrollIntoViewIfNeeded();
  await expect.poll(texturePixels).toBeGreaterThan(2);
  await page.screenshot({ path: test.info().outputPath(`restored-texture-${width}.png`) });
  if (recording) await page.waitForTimeout(1500);
  await writeFile(test.info().outputPath("restored-render-check.json"), JSON.stringify({ width, rgb_range: await pixelRange(), checker_color_pixels: await texturePixels() }));
  await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
  const position = () => viewport.getAttribute("data-camera"), start = await position();
  await page.keyboard.down("d"); try { await expect.poll(position).not.toBe(start); if (recording) await page.waitForTimeout(1500); } finally { await page.keyboard.up("d"); }
  const stranger = await browser.newContext({ baseURL: receipt.origin });
  try { expect((await stranger.request.get(`/api/export/session/${restoredSid}`)).status()).toBe(403); } finally { await stranger.close(); }
  for (const collection of ["place_build_jobs", "mesh_jobs", "material_jobs", "illustration_jobs"]) expect(await db.collection(collection).countDocuments()).toBe(0);
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("production Sketch draws, generates a mock candidate and reopens saved content", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await page.getByRole("link", { name: "New Sketch", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Rectangle", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Sketch title" }).fill("Self-host drawing fixture");
  await page.getByRole("textbox", { name: "Your idea" }).fill("A harbor warehouse beside a lighthouse");
  await page.locator("label").filter({ has: page.getByRole("radio", { name: "Rectangle", exact: true }) }).click();
  const canvas = page.getByTestId("sketch-canvas"), box = await canvas.boundingBox();
  if (!box) throw new Error("Sketch canvas missing");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 12 }); await page.mouse.up();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save drawing", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const id = new URL(page.url()).searchParams.get("id")!;
  const saved = await (await page.request.get(`/api/sketches/${id}`)).json();
  expect(saved.sketch.state.scene.elements.length).toBeGreaterThan(0);
  if (recording) await page.waitForTimeout(1200);
  const generated = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/generate-page");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const generatedResponse = await generated; expect(generatedResponse.status(), await generatedResponse.text()).toBe(200);
  await page.getByRole("button", { name: "Keep Version", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
  const accepted = await (await page.request.get(`/api/sketches/${id}`)).json();
  expect(accepted.candidates).toHaveLength(1); expect(accepted.candidates[0].mock).toBe(true);
  expect(accepted.candidates[0].saved_node_id).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Sketch title" })).toHaveValue("Self-host drawing fixture");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
  const restored = await (await page.request.get(`/api/sketches/${id}`)).json();
  expect(restored.sketch.state).toEqual(saved.sketch.state); expect(restored.candidates).toEqual(accepted.candidates);
  await page.screenshot({ path: test.info().outputPath("sketch-mock-restored.png") });
  if (recording) await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
});

for (const width of [1280, 390]) test(`operator recovery preserves one world's content and private access at ${width}`, async ({ page, browser }) => {
  const db = client.db(receipt.database), title = `Recovered district ${width}`, note = `Private district plans ${width}`;
  const viewport = { width, height: width === 390 ? 844 : 900 };
  await page.setViewportSize(viewport);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const create = async (tab: Page, label: string) => {
    await tab.goto("/"); await tab.getByRole("link", { name: "New 3D World", exact: true }).click();
    await expect(tab.getByTestId("place-viewport").first()).toHaveAttribute("data-ready", "true");
    await tab.getByLabel("Place name", { exact: true }).fill(label);
    await tab.getByRole("combobox", { name: "Component type" }).selectOption("building");
    await tab.getByRole("button", { name: "Add object", exact: true }).click();
    await tab.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await tab.getByRole("button", { name: "Preview", exact: true }).click();
    await tab.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(tab.getByRole("status").filter({ hasText: "Revision 1" })).toHaveText("Revision 1 · Saved");
    return new URL(tab.url()).searchParams.get("world")!;
  };
  const operator = async (...args: string[]) => {
    const result = await exec("docker", ["compose", "--env-file", "/dev/null", "--project-name", receipt.project, "--file", receipt.compose_file,
      "exec", "-T", "place-worker", "node", "--import", "tsx", "scripts/owner-recovery.ts", ...args], { timeout: 30_000 });
    return JSON.parse(result.stdout);
  };
  const sid = await create(page, title), retained = await create(page, `Old browser retained ${width}`);
  await page.goto("/");
  await page.getByRole("article", { name: title, exact: true }).getByRole("button", { name: "Open notebook" }).click();
  await page.getByLabel("Private notes", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("region", { name: "Private note" }).getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Close notebook" }).click();
  const notesUrl = `/api/creator/worlds/${sid}/notes`;
  const before = {
    scenes: await db.collection("place_scenes").find({ session_id: sid }).toArray(),
    notes: await db.collection("creator_notes").find({ session_id: sid }).toArray(),
  };
  const replacement = await browser.newContext({ baseURL: receipt.origin, viewport }), foreign = await browser.newContext({ baseURL: receipt.origin });
  try {
    const tab = await replacement.newPage(); tab.on("pageerror", e => errors.push(e.message));
    const own = await create(tab, `New browser retained ${width}`);
    const owners = await db.collection<{ _id: string }>("session_owners").find().toArray();
    expect((await tab.request.get(notesUrl)).status()).toBe(403);
    expect((await tab.request.get(`/api/export/session/${sid}`)).status()).toBe(403);
    const withdrawn = await operator("issue", "--world", sid, "--reason", "Isolated recovery test");
    expect(await operator("revoke", "--grant", withdrawn.grant_id, "--reason", "Verify operator revocation")).toMatchObject({ revoked: true });
    expect((await tab.request.post("/api/creator/recovery", { data: { code: withdrawn.code } })).status()).toBe(403);
    const superseded = await operator("issue", "--world", sid, "--reason", "Verify supersession");
    const grant = await operator("issue", "--world", sid, "--reason", "Verified test recipient");
    expect((await tab.request.post("/api/creator/recovery", { data: { code: superseded.code } })).status()).toBe(403);
    const inspected = await operator("inspect", "--world", sid);
    expect(inspected.grant).toMatchObject({ id: grant.grant_id, status: "pending" });
    expect(JSON.stringify(inspected)).not.toContain(grant.code);
    await tab.goto("/"); await tab.getByRole("button", { name: "Recover World", exact: true }).click();
    const dialog = tab.getByRole("dialog", { name: "Recover World", exact: true });
    await expect(dialog.getByRole("button", { name: "Restore access", exact: true })).toBeDisabled();
    await dialog.getByLabel("Operator recovery code").fill(grant.code);
    await expect(dialog.getByLabel("Operator recovery code")).toHaveAttribute("type", "password");
    await tab.screenshot({ path: test.info().outputPath(`recovery-code-${width}.png`) });
    await dialog.getByRole("button", { name: "Restore access", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Access restored");
    await tab.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
    await expect(tab.getByRole("button", { name: "Recover World", exact: true })).toBeFocused();
    const card = tab.getByRole("article", { name: title, exact: true }); await expect(card).toBeVisible();
    await expect(tab.getByRole("article", { name: `New browser retained ${width}`, exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Open notebook" }).click();
    await expect(tab.getByLabel("Private notes", { exact: true })).toHaveValue(note);
    await tab.screenshot({ path: test.info().outputPath(`recovered-notes-${width}.png`) });
    await tab.getByRole("button", { name: "Close notebook" }).click();
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await tab.evaluate(secret => !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }).includes(secret), grant.code)).toBe(true);
    expect((await tab.request.post("/api/creator/recovery", { data: { code: grant.code } })).status()).toBe(200);
    expect((await page.request.post("/api/creator/recovery", { data: { code: grant.code } })).status()).toBe(403);
    expect((await foreign.request.post("/api/creator/identity", { data: {} })).status()).toBe(200);
    expect((await foreign.request.post("/api/creator/recovery", { data: { code: grant.code } })).status()).toBe(403);
    for (const endpoint of [notesUrl, `/api/export/session/${sid}`]) {
      expect((await tab.request.get(endpoint)).status()).toBe(200);
      expect((await page.request.get(endpoint)).status()).toBe(403);
      expect((await foreign.request.get(endpoint)).status()).toBe(403);
    }
    expect((await page.request.put(notesUrl, { data: { place_id: null, text: "Unauthorized change", revision: 1 } })).status()).toBe(403);
    for (const id of [retained, own]) {
      expect((await db.collection<{ _id: string }>("session_owners").find().toArray()).find(o => o._id === id)).toEqual(owners.find(o => o._id === id));
    }
    expect(await db.collection("place_scenes").find({ session_id: sid }).toArray()).toEqual(before.scenes);
    expect(await db.collection("creator_notes").find({ session_id: sid }).toArray()).toEqual(before.notes);
    const audit = await db.collection("owner_recovery_grants").find({ session_id: sid }).toArray();
    expect(audit.map(g => g.status).sort()).toEqual(["revoked", "revoked", "used"]);
    expect(JSON.stringify(audit)).not.toContain(grant.code);
    await page.reload(); await expect(page.getByRole("article", { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("article", { name: `Old browser retained ${width}`, exact: true })).toBeVisible();
    if (width === 1280) {
      // Two independent HTTP requests compete against actual Mongo transactions.
      const race = await operator("issue", "--world", sid, "--reason", "Concurrent recipient test");
      const results = await Promise.all([page.request, foreign.request].map(request => request.post("/api/creator/recovery", { data: { code: race.code } })));
      expect(results.map(r => r.status()).sort()).toEqual([200, 403]);
    }
    for (const collection of ["place_build_jobs", "mesh_jobs", "material_jobs", "illustration_jobs"]) expect(await db.collection(collection).countDocuments()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await replacement.close(); await foreign.close(); }
});
