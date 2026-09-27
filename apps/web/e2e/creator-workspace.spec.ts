import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MongoClient, type Document } from "mongodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_CREATOR !== "1", "Explicit localhost creator-workspace test; no model calls");
const token = randomUUID(), stranger = randomUUID(), prefix = `creator-test-${randomUUID()}`;
const main = `${prefix}-main`, long = `${prefix}-long`, legacy = `${prefix}-legacy`, foreign = `${prefix}-foreign`;
const ids = [main, long, legacy, foreign, ...Array.from({ length: 20 }, (_, i) => `${prefix}-extra-${i}`)];
const cleanupIds = [...ids];
const client = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true");
const s3 = new S3Client({ region: "auto", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "openflipbook", secretAccessKey: "openflipbook-local" } });
const key = `creator-tests/${prefix}/map.jpg`;
const db = () => client.db("openflipbook_healthcheck");
const root = (session: string) => `${session}-n0`;
const paidRoute = /\/api\/(generate|animate|ltx|resolve|precompute)|\/api\/world\/[^/]+\/(extract|plan-world)/;

test.beforeEach(async ({ context }) => {
  await context.route(paidRoute, route => route.abort("blockedbyclient"));
});

test.beforeAll(async ({ baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1") throw new Error("Creator tests require an explicit 127.0.0.1 base URL");
  await client.connect();
  await s3.send(new PutObjectCommand({ Bucket: "openflipbook", Key: key, Body: await readFile("../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg"), ContentType: "image/jpeg" }));
  const now = Date.now();
  for (const [index, session] of ids.entries()) {
    if (session !== legacy) await db().collection("session_owners").insertOne({ _id: session as never, owner_token: session === foreign ? stranger : token, created_at: new Date(now) });
    await db().collection<Document & { _id: string }>("nodes").insertMany(Array.from({ length: session === long ? 202 : 1 }, (_, i) => ({
      _id: `${session}-n${i}`, session_id: session, parent_id: i ? `${session}-n${i - 1}` : null,
      page_title: session === main ? "Aethelgard Harbor" : session === long ? `Archive view ${i}` : `Saved world ${index}`,
      query: "Illustrated harbor", image_key: key, image_model: "existing-fixture", prompt_author_model: "test-fixture", aspect_ratio: "16:9", sources: [], relation: "descend", click_in_parent: null,
      scene_view: { node_id: `${session}-n${i}`, level: "map", observer: null, map_crop: null, focus_id: null },
      // Deliberately unextracted: resume must not trigger paid recovery.
      created_at: new Date(now - index * 10000 + i),
    })));
  }
  await db().collection("world_map").insertOne({ _id: main as never, schema_version: 1, bounds: { x: 0, y: 0, w: 100, h: 60 }, updated_at: new Date(now), entities: [{ id: "market", entity_id: "market-entity", kind: "place", label: "Quayside Market", visual: "Timber market", pos: { x: 60, y: 30 }, height: 5, footprint: { w: 12, d: 10 }, parent_id: null, source: "user", confidence: 1, state: {}, updated_at: new Date(now).toISOString() }] });
  await db().collection("published_sessions").insertOne({ _id: main as never, node_id: root(main), title: "Aethelgard Harbor", query: "Illustrated harbor", poster_key: key, published_at: new Date(now) });
});

test.afterAll(async () => {
  try {
    for (const name of ["nodes", "creator_notes"]) await db().collection(name).deleteMany({ session_id: { $in: cleanupIds } });
    for (const name of ["creator_worlds", "session_owners", "world_map", "world_state", "published_sessions"]) await db().collection(name).deleteMany({ _id: { $in: cleanupIds } } as never);
    await s3.send(new DeleteObjectCommand({ Bucket: "openflipbook", Key: key }));
  } finally { await client.close(); s3.destroy(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`library, notes, place notebook and reliable resume at ${viewport.width}`, async ({ context, page, baseURL }) => {
    await context.addCookies([{ name: "ofb_owner", value: token, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    const paid: string[] = [], errors: string[] = [];
    page.on("request", req => { if (paidRoute.test(req.url())) paid.push(req.url()); });
    page.on("pageerror", e => errors.push(e.message));
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "My Worlds", exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(20);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByRole("article")).toHaveCount(22);
    await page.getByRole("textbox", { name: "Search worlds" }).fill("Aethelgard");
    await expect(page.getByRole("article")).toHaveCount(1);
    const card = page.getByRole("article").first();
    await expect(card.getByRole("img")).toBeVisible();
    await card.getByRole("button", { name: "Pin world" }).click();
    await expect(card.getByRole("button", { name: "Unpin world" })).toBeVisible();
    await card.getByRole("button", { name: "Unpin world" }).click();
    await card.getByRole("button", { name: "Rename world" }).click();
    await card.getByRole("textbox", { name: "World title" }).fill("Aethelgard Working Atlas");
    await card.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: "Aethelgard Working Atlas" })).toBeVisible();
    await card.getByRole("button", { name: "Archive world" }).click();
    await expect(page.getByRole("article")).toHaveCount(0);
    await page.getByRole("tab", { name: "Archived", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
    await card.getByRole("button", { name: "Restore world" }).click();
    await page.getByRole("tab", { name: "Active", exact: true }).click();
    await card.getByRole("button", { name: "Open notebook" }).click();
    const text = `Private harbor history ${viewport.width}`;
    await page.getByRole("textbox", { name: "Private notes" }).fill(text);
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/creator-${viewport.width}-notebook.png` });
    await page.getByRole("button", { name: "Close notebook" }).click();
    await page.reload(); await page.getByRole("textbox", { name: "Search worlds" }).fill("Aethelgard");
    await page.getByRole("article").first().getByRole("button", { name: "Open notebook" }).click();
    await expect(page.getByRole("textbox", { name: "Private notes" })).toHaveValue(text);
    await page.getByRole("textbox", { name: "Private notes" }).fill("unsaved draft");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "Close notebook" }).click();
    await expect(page.getByRole("dialog", { name: "World notebook" })).toBeVisible();
    page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Close notebook" }).click();
    await page.getByRole("article").first().getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Notebook", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Inspect places", exact: true }).click();
    await page.getByRole("button", { name: "Quayside Market", exact: true }).click();
    await page.getByRole("tab", { name: "Notes", exact: true }).click();
    await page.getByRole("textbox", { name: "Private notes" }).fill(`Market secrets ${viewport.width}`);
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close place inspector" }).click();
    await page.getByRole("link", { name: "My Worlds", exact: true }).click();
    await page.getByRole("textbox", { name: "Search worlds" }).fill("");
    await expect(page.getByRole("article")).toHaveCount(20);
    await page.screenshot({ path: `test-results/creator-${viewport.width}-library.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(`/play?continue=${long}&node=${long}-n200`);
    await expect(page.getByRole("button", { name: "Notebook", exact: true })).toBeVisible();
    await expect.poll(async () => (await db().collection("creator_worlds").findOne({ _id: long as never }))?.resume_node_id).toBe(`${long}-n200`);
    await page.reload();
    await expect(page.getByRole("button", { name: "Notebook", exact: true })).toBeVisible();
    await expect(page.getByText("Archive view 200", { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "My Worlds", exact: true }).click();
    const continued = page.getByRole("article", { name: "Archive view 0", exact: true }).getByRole("link", { name: "Continue", exact: true });
    await expect(continued).toHaveAttribute("href", `/play?continue=${long}&node=${long}-n200`);
    await continued.click();
    await expect(page.getByText("Archive view 200", { exact: true }).first()).toBeVisible();
    expect(paid).toEqual([]); expect(errors).toEqual([]);
  });
}

test("two tabs resolve conflicts without silently replacing either draft", async ({ context, page, baseURL }) => {
  await context.addCookies([{ name: "ofb_owner", value: token, url: baseURL!, httpOnly: true }]);
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto("/");
    await tab.getByRole("textbox", { name: "Search worlds" }).fill("Aethelgard");
    await tab.getByRole("article").getByRole("button", { name: "Open notebook" }).click();
    await expect(tab.getByRole("textbox", { name: "Private notes" })).toBeVisible();
  }
  await page.getByRole("textbox", { name: "Private notes" }).fill("First tab changes");
  await second.getByRole("textbox", { name: "Private notes" }).fill("Second tab draft");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(second.getByText("First tab changes", { exact: true })).toBeVisible();
  await expect(second.getByRole("textbox", { name: "Private notes" })).toHaveValue("Second tab draft");
  await expect(second.getByRole("button", { name: "Save note", exact: true })).toBeDisabled();
  await second.getByRole("button", { name: "Keep my draft", exact: true }).click();
  await second.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(second.getByText("Saved", { exact: true })).toBeVisible();
  const data = await (await context.request.get(`/api/creator/worlds/${main}/notes`)).json();
  expect(data.notes.find((n: { place_id: string | null }) => n.place_id === null).text).toBe("Second tab draft");
  await second.close();
});

test("failed resume retries saved content and the upload entry hydrates cleanly", async ({ context, page, baseURL }) => {
  await context.addCookies([{ name: "ofb_owner", value: token, url: baseURL!, httpOnly: true }]);
  const paid: string[] = [], errors: string[] = [];
  page.on("request", req => { if (paidRoute.test(req.url())) paid.push(req.url()); });
  page.on("pageerror", e => errors.push(e.message));
  const endpoint = `**/api/sessions/${long}*`;
  await page.route(endpoint, route => route.fulfill({ status: 503, json: { error: "Temporary failure" } }));
  await page.goto(`/play?continue=${long}&node=${long}-n201`);
  await expect(page.getByRole("alert").filter({ hasText: "Could not load saved world" })).toBeVisible();
  await page.unroute(endpoint);
  await page.getByRole("button", { name: "Retry saved world" }).click();
  await expect(page.getByRole("button", { name: "Notebook", exact: true })).toBeVisible();
  await expect(page.getByText("Archive view 201", { exact: true }).first()).toBeVisible();
  await page.goto("/play?upload=1");
  await expect(page.getByRole("button", { name: "Choose map image", exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(paid).toEqual([]);
});

test("private routes isolate owners, preserve orphan notes and exclude public surfaces", async ({ browser, baseURL }) => {
  const owner = await browser.newContext({ baseURL: baseURL! }), other = await browser.newContext({ baseURL: baseURL! });
  await owner.addCookies([{ name: "ofb_owner", value: token, url: baseURL!, httpOnly: true }]);
  await other.addCookies([{ name: "ofb_owner", value: stranger, url: baseURL!, httpOnly: true }]);
  try {
    const endpoint = `/api/creator/worlds/${main}/notes`;
    const res = await owner.request.get(endpoint); expect(res.status()).toBe(200); expect(res.headers()["cache-control"]).toContain("no-store");
    const notes = (await res.json()).notes;
    expect((await other.request.get(endpoint)).status()).toBe(403);
    expect((await other.request.put(endpoint, { data: { place_id: null, text: "poison", revision: 0 } })).status()).toBe(403);
    const otherWorlds = await (await other.request.get("/api/creator/worlds")).json(); expect(otherWorlds.worlds.map((w: { id: string }) => w.id)).toEqual([foreign]);
    expect((await owner.request.get(`/api/creator/worlds/${legacy}/notes`)).status()).toBe(403);
    expect(await db().collection("session_owners").findOne({ _id: legacy as never })).toBeNull();
    const original = notes.find((n: { place_id: string | null }) => n.place_id === null) ?? { revision: 0 };
    const first = await owner.request.put(endpoint, { data: { place_id: null, text: "creator-private-sentinel", revision: original.revision } }); expect(first.status()).toBe(200);
    expect((await owner.request.put(endpoint, { data: { place_id: null, text: "stale", revision: original.revision } })).status()).toBe(409);
    expect((await owner.request.patch(`/api/creator/worlds/${main}`, { data: { resume_node_id: root(foreign) } })).status()).toBe(404);
    expect((await owner.request.put(endpoint, { headers: { origin: "https://evil.test" }, data: { place_id: null, text: "bad", revision: 2 } })).status()).toBe(403);
    for (const path of [`/api/sessions/${main}`, `/api/world/${main}`, `/api/world/${main}/map`, `/embed/${main}`, `/n/${root(main)}`]) {
      const publicResponse = await other.request.get(path); expect(await publicResponse.text()).not.toContain("creator-private-sentinel");
    }
    const zipResponse = await other.request.get(`/api/export/session/${main}`); expect(zipResponse.status()).toBe(200);
    const zip = await JSZip.loadAsync(await zipResponse.body());
    for (const entry of Object.values(zip.files).filter(entry => entry.name.endsWith(".json"))) expect(await entry.async("string")).not.toContain("creator-private-sentinel");
    const fork = await other.request.post(`/api/sessions/${main}/fork`, { data: {} }); expect(fork.status()).toBe(200);
    const forked = await fork.json(); cleanupIds.push(forked.session_id);
    expect(await db().collection("creator_notes").countDocuments({ session_id: forked.session_id })).toBe(0);
    const market = notes.find((n: { place_id: string | null }) => n.place_id === "market");
    if (!market) expect((await owner.request.put(endpoint, { data: { place_id: "market", text: "Market history", revision: 0 } })).status()).toBe(200);
    await db().collection("world_map").updateOne({ _id: main as never }, { $set: { entities: [] } });
    const orphan = (await (await owner.request.get(endpoint)).json()).notes.find((n: { place_id: string }) => n.place_id === "market"); expect(orphan.missing_place).toBe(true);
    expect((await owner.request.put(endpoint, { data: { place_id: "market", text: "Retained after removal", revision: orphan.revision } })).status()).toBe(200);
  } finally { await owner.close(); await other.close(); }
});
