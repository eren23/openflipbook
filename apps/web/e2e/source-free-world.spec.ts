import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import JSZip from "jszip";
import { emptyPlaceScene } from "../lib/place-scene";

test.skip(process.env.E2E_SOURCE_FREE_WORLD !== "1", "Opt-in real-database creation through ordinary UI; no model calls");

test("concurrent fresh creation commits one world and one revision", async ({ request, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local server required");
  process.loadEnvFile(".env.local");
  const client = new MongoClient(process.env.MONGODB_URI!); await client.connect();
  const db = client.db(process.env.MONGODB_DB), requestId = crypto.randomUUID(), sid = `session_${requestId}`;
  // Both requests originate from one established browser credential, not two
  // anonymous clients racing to establish different owner cookies.
  const token = crypto.randomUUID();
  const data = { request_id: requestId, definition: emptyPlaceScene() };
  const send = () => request.post("/api/creator/worlds", { data, headers: { cookie: `ofb_owner=${token}` } });
  try {
    const a = send(), b = send();
    const first = await a, second = await b;
    expect(first.status()).toBe(200); expect(second.status()).toBe(200);
    expect((await first.json()).scene).toEqual((await second.json()).scene);
    expect(await db.collection("place_scene_versions").countDocuments({ session_id: sid })).toBe(1);
    expect(await db.collection("world_edit_proposals").countDocuments({ session_id: sid })).toBe(1);
    expect(await db.collection("nodes").countDocuments({ session_id: sid })).toBe(0);
  } finally {
    for (const name of ["place_scenes", "place_scene_versions", "world_edit_proposals"]) await db.collection(name).deleteMany({ session_id: sid });
    for (const name of ["world_map", "world_state", "session_owners", "creator_worlds"]) await db.collection(name).deleteOne({ _id: sid as never });
    await client.close();
  }
});

for (const width of [1280, 390]) test(`source-free creation, editing, library, export and ownership at ${width}`, async ({ page, browser, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local server required");
  process.loadEnvFile(".env.local");
  const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB), created: string[] = [], errors: string[] = [], generation: string[] = [];
  let creationBody: Record<string, unknown> | null = null;
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/creator/worlds") creationBody = r.postDataJSON(); });
  page.on("response", async r => {
    if (r.ok() && r.request().method() === "POST" && new URL(r.url()).pathname === "/api/creator/worlds") {
      const value = await r.json(); if (value.session_id && !created.includes(value.session_id)) created.push(value.session_id);
    }
  });
  await page.route(/\/api\/(generate-page|sketches\/[^/]+\/generate|world\/[^/]+\/meshes)/, route => {
    if (route.request().method() !== "GET") { generation.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const ready = async () => expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    await page.getByRole("link", { name: "New 3D World", exact: true }).click();
    await ready();
    await expect(page.getByRole("button", { name: "Reference", exact: true })).toHaveCount(0);
    const title = `Source-free ${width} ${Date.now()}`;
    await page.getByRole("textbox", { name: "Place name", exact: true }).fill(title);
    await page.getByRole("combobox", { name: "Component type" }).selectOption("building");
    await page.getByRole("button", { name: "Add object", exact: true }).click();
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Revision 1" })).toHaveText("Revision 1 · Saved");
    await ready();
    const url = new URL(page.url()), sid = url.searchParams.get("world")!, pid = url.searchParams.get("place")!;
    expect(sid).toMatch(/^session_/); if (!created.includes(sid)) created.push(sid);
    expect(await db.collection("nodes").countDocuments({ session_id: sid })).toBe(0);
    const first = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
    expect(first).toMatchObject({ source_node_id: null, source_image_key: null, revision: 1 });
    const objectId = first!.definition.objects[0].id;
    await page.getByRole("button", { name: "Building building", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Object x", exact: true }).fill("23");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved");
    await page.reload(); await ready();
    await page.getByRole("button", { name: "Building building", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Object x", exact: true })).toHaveValue("23");
    const replay = await page.request.post("/api/creator/worlds", { data: creationBody });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).scene.revision).toBe(2);
    expect(await db.collection("place_scene_versions").countDocuments({ session_id: sid })).toBe(2);
    await page.getByRole("button", { name: "3D", exact: true }).click(); await ready();
    await page.getByRole("button", { name: "Frame selected in 3D" }).click();
    await page.waitForTimeout(250);
    const range = await page.getByTestId("place-viewport").locator("canvas").evaluate(el => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const values = [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 !== 3);
      return Math.max(...values) - Math.min(...values);
    });
    expect(range).toBeGreaterThan(30);
    await page.screenshot({ path: `test-results/source-free-${width}-saved.png` });
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready();
    const camera = async () => (await page.getByTestId("place-viewport").getAttribute("data-camera"))!.split(",").map(Number);
    const start = (await camera())[0]!;
    await page.keyboard.down("d");
    await expect.poll(async () => (await camera())[0]).toBeGreaterThan(start + 0.5);
    await page.keyboard.up("d");
    await expect.poll(async()=>(await db.collection("creator_worlds").findOne({_id:sid as never}))?.walk_position?.pose?.position?.x??0).toBeGreaterThan(start+0.4);
    await expect(page.getByRole("status").filter({hasText:/^Position saved$/})).toBeVisible();
    await page.getByRole("link", { name: "My Worlds", exact: true }).click();
    const card = page.getByRole("article", { name: title, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: "Continue", exact: true })).toHaveAttribute("href", `/sketch/world?world=${sid}&place=${pid}&view=walk`);
    await card.getByRole("button", { name: "Pin world" }).click();
    await expect(card.getByRole("button", { name: "Unpin world" })).toBeVisible();
    await page.screenshot({ path: `test-results/source-free-${width}-library.png` });
    await card.getByRole("link", { name: "Continue", exact: true }).click(); await ready();
    await expect(page.getByRole("status").filter({ hasText: "Revision 2" })).toHaveText("Revision 2 · Saved");

    const zipRes = await page.request.get(`/api/export/session/${sid}`);
    await expect(page.getByRole("link", { name: "Export world" })).toHaveAttribute("href", `/api/export/session/${sid}`);
    expect(zipRes.status()).toBe(200);
    const zip = await JSZip.loadAsync(await zipRes.body());
    expect(JSON.parse(await zip.file("graph.json")!.async("string")).nodes).toEqual([]);
    const scenes = JSON.parse(await zip.file("place-scenes.json")!.async("string"));
    expect(scenes).toHaveLength(2);
    expect(scenes[1].definition.objects[0]).toMatchObject({ id: objectId, x: 23 });
    expect(JSON.parse(await zip.file("references.json")!.async("string"))).toEqual([]);
    const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${sid}/fork` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Fork world", exact: true }).click();
    const forkRes = await forkResponse;
    expect(forkRes.status()).toBe(200);
    const fork = await forkRes.json(); created.push(fork.session_id);
    expect(fork).toMatchObject({ nodes: 0, place_id: pid });
    await expect(page).toHaveURL(new RegExp(`world=${fork.session_id}`)); await ready();
    const forkScene = await page.request.get(`/api/world/${fork.session_id}/places/${pid}/scene`);
    expect(forkScene.status()).toBe(200);
    expect((await forkScene.json()).scene.definition.objects[0]).toMatchObject({ id: objectId, x: 23 });

    const stranger = await browser.newContext({ baseURL });
    try {
      for (const path of [`/api/world/scene-context?world=${sid}&place=${pid}`, `/api/world/${sid}`, `/api/world/${sid}/map`, `/api/export/session/${sid}`, `/api/world/${fork.session_id}/map`]) {
        expect((await stranger.request.get(path)).status(), path).toBe(403);
      }
      expect((await stranger.request.post(`/api/sessions/${sid}/fork`, { data: {} })).status()).toBe(403);
      expect((await stranger.request.post("/api/creator/worlds", { data: { request_id: crypto.randomUUID(), definition: emptyPlaceScene() } })).status()).toBe(409);
    } finally { await stranger.close(); }
    expect(await db.collection("nodes").countDocuments({ session_id: { $in: created } })).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(generation).toEqual([]); expect(errors).toEqual([]);
  } finally {
    for (const sid of created) {
      for (const name of ["nodes", "place_scenes", "place_scene_versions", "world_edit_proposals"]) await db.collection(name).deleteMany({ session_id: sid });
      for (const name of ["world_map", "world_state", "session_owners", "creator_worlds"]) await db.collection(name).deleteOne({ _id: sid as never });
    }
    await client.close();
  }
});
