/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { readServerEnv, requireR2 } from "../lib/env";
import { r2ClientConfig } from "../lib/r2";

test.skip(process.env.E2E_DRUM_WORLD !== "1", "Opt-in real persistence test; imports existing images, never generates");
test("map, edited image and fitted materials share one revisioned place", async ({ page, browser, baseURL }) => {
  if (!baseURL || !/^(localhost|127\.0\.0\.1)$/.test(new URL(baseURL).hostname)) throw new Error("Local server required");
  process.loadEnvFile(".env.local");
  const client = new MongoClient(process.env.MONGODB_URI!); await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const r2 = requireR2(readServerEnv()), s3 = new S3Client(r2ClientConfig(r2));
  let sid = "";
  const errors: string[] = [], generated: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/generate-page", route => { generated.push(route.request().url()); return route.abort(); });
  await page.route("**/api/sketches/*/generate", route => { generated.push(route.request().url()); return route.abort(); });
  const ready = async () => expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/sketch/world/ankh");
    await page.getByRole("button", { name: "Save to world", exact: true }).click();
    await page.waitForURL("**/sketch/world?**"); await ready();
    const source = new URL(page.url()).searchParams.get("source")!;
    const contextUrl = `/api/world/scene-context?source=${source}`;
    const initial = await (await page.request.get(contextUrl)).json(); sid = initial.session_id;
    expect(initial.scene).toBeNull(); expect(initial.versions).toHaveLength(2);
    await expect.poll(async () => Number(await page.getByTestId("place-viewport").getAttribute("data-textured"))).toBeGreaterThan(100);
    await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-camera", "27.000,2.200,9.400");
    const distance = Math.hypot(-14, 0.6, 6.3);
    await expect(page.getByTestId("place-viewport")).toHaveAttribute("data-direction", [-14, 0.6, 6.3].map(n => (n / distance).toFixed(6)).join(","));
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("region", { name: "World change preview" })).toContainText("10.00 x 5.40 m -> 10.00 x 7.16 m");
    expect((await (await page.request.get(contextUrl)).json()).scene).toBeNull();
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Revision 1 · Saved");
    const first = (await (await page.request.get(contextUrl)).json()).scene;
    await page.getByRole("button", { name: "The Mended Drum tavern", exact: true }).click();
    await page.getByRole("button", { name: "teal roof", exact: true }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("region", { name: "World change preview" })).not.toContainText("footprint");
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Revision 2 · Saved");
    const editorUrl = page.url();
    await page.reload(); await ready();
    await page.getByRole("button", { name: "The Mended Drum tavern", exact: true }).click();
    await expect(page.getByRole("button", { name: "teal roof", exact: true })).toHaveAttribute("aria-pressed", "true");
    const second = (await (await page.request.get(contextUrl)).json()).scene;
    expect(second.definition.objects.map((o: any) => ({ ...o, roof_material: undefined }))).toEqual(first.definition.objects.map((o: any) => ({ ...o, roof_material: undefined })));
    await page.screenshot({ path: "test-results/drum-world-saved-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/drum-world-saved-mobile.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: "Street image", exact: true }).click();
    const versions = page.getByRole("combobox", { name: "Image version", exact: true });
    await expect(versions.locator("option")).toHaveCount(2);
    const edited = initial.versions.find((v: any) => v.id !== source).id;
    await versions.selectOption(edited);
    await expect(page.getByRole("link", { name: "Edit in Sketch", exact: true })).toHaveAttribute("href", `/sketch?source=${edited}`);
    await expect.poll(() => page.getByAltText("The Mended Drum on Filigree Street").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: "test-results/drum-world-image-mobile.png" });
    const editedContext = await (await page.request.get(`/api/world/scene-context?source=${edited}`)).json();
    expect(editedContext.scene.id).toBe(first.id); expect(editedContext.source_node_id).toBe(source);
    const stranger = await browser.newContext({ baseURL });
    try { expect((await stranger.request.get(contextUrl)).status()).toBe(403); } finally { await stranger.close(); }
    await page.goto(editorUrl); await ready();
    await page.getByRole("combobox", { name: "Restore revision", exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Revision 3 · Saved");
    expect((await (await page.request.get(contextUrl)).json()).scene.definition).toEqual(first.definition);
    expect(errors).toEqual([]); expect(generated).toEqual([]);
  } finally {
    if (sid) {
      const nodes = await db.collection("nodes").find({ session_id: sid }).toArray();
      if (nodes.length) await s3.send(new DeleteObjectsCommand({ Bucket: r2.bucket, Delete: { Objects: nodes.map(n => ({ Key: n.image_key })) } }));
      for (const name of ["nodes", "place_scenes", "place_scene_versions", "world_edit_proposals"]) await db.collection(name).deleteMany({ session_id: sid });
      for (const name of ["world_map", "world_state", "session_owners"]) await db.collection(name).deleteOne({ _id: sid as never });
      await db.collection("idempotency_keys").deleteMany({ _id: { $in: ["map", "street", "teal"].map(name => `node:${sid}:drum-v1-${name}`) } } as never);
    }
    s3.destroy(); await client.close();
  }
});
