import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MongoClient, type Document } from "mongodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_ARRIVAL !== "1", "Opt-in local arrival test; mocked generation, no paid calls");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000 });
const client = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true");
const db = () => client.db("openflipbook_healthcheck");
const s3 = new S3Client({ region: "auto", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "openflipbook", secretAccessKey: "openflipbook-local" } });
const sessions: string[] = [], keys: string[] = [];
const sourceName = "Arrival fixture source";
let bytes: Buffer;
test.beforeAll(async ({ baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1") throw new Error("Localhost only");
  await client.connect();
  bytes = await readFile("../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg");
});
test.afterAll(async () => {
  try {
    const nodes = await db().collection("nodes").find({ session_id: { $in: sessions } }).toArray();
    for (const key of new Set([...keys, ...nodes.map(n => n.image_key)])) await s3.send(new DeleteObjectCommand({ Bucket: "openflipbook", Key: key }));
    await db().collection("nodes").deleteMany({ session_id: { $in: sessions } });
    for (const col of ["world_map", "world_state", "session_owners", "creator_worlds"]) await db().collection(col).deleteMany({ _id: { $in: sessions } } as never);
  } finally { await client.close(); s3.destroy(); }
});

for (const width of [1440, 390]) {
  test(`normal click rejects then saves and reuses an exterior at ${width}`, async ({ page, context, baseURL }) => {
    const session = `arrival-e2e-${randomUUID()}`, node = `${session}-root`, owner = randomUUID(); sessions.push(session);
    const key = `${session}/source.jpg`; keys.push(key);
    await s3.send(new PutObjectCommand({ Bucket: "openflipbook", Key: key, Body: bytes, ContentType: "image/jpeg" }));
    await db().collection("session_owners").insertOne({ _id: session as never, owner_token: owner });
    await db().collection<Document & { _id: string }>("nodes").insertOne({ _id: node, session_id: session, parent_id: null, page_title: sourceName, query: "Mock harbor arrival fixture", image_key: key, image_model: "fixture", prompt_author_model: "fixture", aspect_ratio: "16:9", sources: [], relation: "descend", created_at: new Date(), geo_extracted: true, scene_view: { node_id: node, level: "map", observer: null, map_crop: null, focus_id: null } });
    const place = { id: "crystal", entity_id: null, kind: "place", label: "Crystal Lighthouse", visual: "Mock extracted lighthouse", pos: { x: 13.8, y: 18.72 }, height: 12, footprint: { w: 12, d: 26 }, parent_id: null, source: "extracted", confidence: 1, state: {}, updated_at: new Date().toISOString() };
    await db().collection("world_map").insertOne({ _id: session as never, schema_version: 1, bounds: { x: 0, y: 0, w: 100, h: 60 }, entities: [place], updated_at: new Date() });
    await context.addCookies([{ name: "ofb_owner", value: owner, url: baseURL!, httpOnly: true }]);
    // Provider traffic is blocked even if a regression triggers an extra call.
    await context.route(/\/api\/(animate|ltx|resolve|precompute)|\/api\/world\/[^/]+\/(extract|plan-world)/, route => route.fulfill({ status: 503, json: { error: "Offline arrival fixture" } }));
    let submissions = 0;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/generate-page", async route => {
      const request = route.request().postDataJSON(); submissions++;
      expect(request.strict_world).toBe(true); expect(request.arrival_intent).toBe("exterior"); expect(request.target_geo_id).toBe("crystal");
      const accepted = submissions > 1;
      const arrival = { status: accepted ? "pass" : "fail", checks: { near_target: accepted ? "pass" : "fail", exterior: "pass", single_target: "pass", scene_not_map: "pass" }, rationale: "Mock arrival verdict" };
      const view_verdict = { accepted, attempts: 1, same_place: 9, medium: 9, conformance: 9, detail: 9, interior: null, arrival };
      const image = `data:image/jpeg;base64,${bytes.toString("base64")}`;
      const event = accepted ? { type: "final", image_data_url: image, page_title: "Mock exterior arrival", image_model: "fixture", prompt_author_model: "fixture", session_id: session, final_prompt: "Mocked generation, not visual evidence", sources: [], view_verdict, scene_view: { ...request.scene_view, place_form: "generic" } } : { type: "error", message: "Arrival too distant. Your world is unchanged.", candidate_image_data_url: image, view_verdict };
      await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(event)}\n\n` });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/play?continue=${session}&node=${node}`);
    const source = page.getByRole("img", { name: "Generated illustration for Mock harbor arrival fixture", exact: true });
    await expect(source).toBeVisible();
    const originalSrc = (await source.getAttribute("src"))!;
    await page.getByRole("button", { name: "Inspect places", exact: true }).click();
    await expect(page.getByRole("button", { name: "Crystal Lighthouse", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close place inspector" }).click();
    const size = await source.boundingBox();
    await source.click({ position: { x: size!.width * .138, y: size!.height * .312 } });
    await expect(page.getByRole("region", { name: "Unpublished candidate" })).toBeVisible();
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute("src", originalSrc);
    expect(await db().collection("nodes").countDocuments({ session_id: session })).toBe(1);
    await page.screenshot({ path: `test-results/arrival-${width}-rejected.png` });
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect.poll(() => db().collection("nodes").countDocuments({ session_id: session })).toBe(2);
    const saved = await db().collection("nodes").findOne({ session_id: session, parent_id: node });
    await expect(page.getByText(`/n/${saved!._id}`, { exact: true })).toBeVisible();
    expect(saved?.view_verdict.arrival.status).toBe("pass");
    await page.getByRole("button", { name: /back$/, exact: false }).first().click();
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute("src", originalSrc);
    await page.getByRole("button", { name: "Open branch: Mock exterior arrival", exact: true }).click();
    await expect(page.getByText(`/n/${saved!._id}`, { exact: true })).toBeVisible();
    expect(submissions).toBe(2);
    await page.goto(`/play?continue=${session}&node=${saved!._id}`);
    const reloaded = source;
    await expect(reloaded).toBeVisible();
    expect((await reloaded.getAttribute("src"))?.endsWith(saved!.image_key)).toBe(true);
    expect(submissions).toBe(2); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // An ambiguous next click offers a choice rather than generating for a guessed target.
    await db().collection("world_map").updateOne({ _id: session as never }, { $set: { entities: [place, { ...place, id: "other", label: "Other lighthouse" }] } });
    await page.goto(`/play?continue=${session}&node=${node}`);
    await expect(source).toBeVisible();
    await page.getByRole("button", { name: "Inspect places", exact: true }).click();
    await expect(page.getByRole("button", { name: "Other lighthouse", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close place inspector" }).click();
    const box = await source.boundingBox();
    await source.click({ position: { x: box!.width * .18, y: box!.height * .38 } });
    await expect(page.getByRole("dialog", { name: "Choose a place" })).toBeVisible();
    expect(submissions).toBe(2);
  });
  test(`offline comparison inputs render at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/arrivals");
    await expect(page.getByRole("heading", { name: "Exterior arrivals", exact: true })).toBeVisible();
    await expect(page.getByText("12 planned trials", { exact: true })).toBeVisible();
    for (const name of ["North Point Lighthouse", "Sandstone Citadel", "Crystal Lighthouse"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      for (const image of await page.locator("img").all()) {
        await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
      }
      await expect(page.getByRole("article")).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: `test-results/arrival-${width}-study.png`, fullPage: true });
  });
}
