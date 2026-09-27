import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import JSZip from "jszip";

test.skip(process.env.E2E_FLOOR_FURNISHING !== "1", "Opt-in real-database furnishing workflow; no model calls");

for (const width of [1280, 390]) test(`floor furnishing, building transforms and persistence at ${width}`, async ({ page, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local server required");
  process.loadEnvFile(".env.local");
  const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 }); await client.connect();
  const db = client.db(process.env.MONGODB_DB), created: string[] = [], errors: string[] = [], generation: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", async r => {
    if (r.ok() && r.request().method() === "POST" && /\/api\/creator\/worlds$|\/fork$/.test(new URL(r.url()).pathname)) {
      const data = await r.json(); if (data.session_id && !created.includes(data.session_id)) created.push(data.session_id);
    }
  });
  await page.route(/\/api\/(generate-page|sketches\/[^/]+\/generate|world\/[^/]+\/meshes)/, route => {
    if (route.request().method() !== "GET") { generation.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const ready = async () => expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  const save = async (revision: number) => {
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "Apply to world", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready();
  };
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/sketch/world"); await ready();
    await page.getByRole("combobox", { name: "Component type" }).selectOption("building");
    await page.getByRole("button", { name: "Add object", exact: true }).click();
    await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("2");
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check();
    await save(1);
    const url = new URL(page.url()), sid = url.searchParams.get("world")!, pid = url.searchParams.get("place")!;
    if (!created.includes(sid)) created.push(sid);
    const first = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
    const building = first!.definition.objects[0], upper = building.structure.floors[1].id, ground = building.structure.floors[0].id;
    await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption(upper);
    await page.getByRole("combobox", { name: "Component type" }).selectOption("bench");
    await page.getByRole("button", { name: "Add object", exact: true }).click();
    await page.getByRole("textbox", { name: "Object name", exact: true }).fill("Upper bench");
    await page.getByRole("spinbutton", { name: "Object x", exact: true }).fill("1");
    await save(2);
    const second = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid }), bench = second!.definition.objects[1];
    expect(bench).toMatchObject({ x: 1, z: 0, placement: { building_id: building.id, floor_id: upper } });
    await page.getByRole("button", { name: "Building building", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Object x", exact: true }).fill("24");
    await page.getByRole("spinbutton", { name: "Object rotation", exact: true }).fill("90");
    await page.getByRole("spinbutton", { name: "Object height", exact: true }).fill("8.6");
    await save(3);
    const third = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
    expect(third!.definition.objects[1]).toEqual(bench);
    const map = await db.collection("world_map").findOne({ _id: sid as never }), geo = map!.entities.find((o: { id: string }) => o.id === bench.id);
    expect(geo).toMatchObject({ parent_id: building.id, floor_id: upper, elevation: expect.closeTo(3.6, 8), pos: { x: expect.closeTo(0, 8), y: 1 }, heading: Math.PI / 2 });
    await page.reload(); await ready();
    await page.getByRole("button", { name: "Upper bench bench", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Object floor", exact: true })).toHaveValue(upper);
    await expect(page.getByRole("spinbutton", { name: "Object x", exact: true })).toHaveValue("1");
    await page.getByRole("button", { name: "3D", exact: true }).click(); await ready();
    await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
    await page.waitForTimeout(300);
    const canvas = page.getByTestId("place-viewport").locator("canvas");
    const pixels = await canvas.evaluate(el => {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const ctx = c.getContext("2d")!; ctx.drawImage(el as HTMLCanvasElement, 0, 0, 128, 128);
      const data = ctx.getImageData(0, 0, 128, 128).data; let colored = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! > data[i + 1]! * 1.2 && data[i]! > data[i + 2]! * 1.25) colored++;
      return colored;
    });
    expect(pixels).toBeGreaterThan(50);
    await canvas.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/floor-furnishing-${width}-upper.png` });
    await page.getByRole("button", { name: "Building building", exact: true }).click();
    await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("1");
    await expect(page.getByRole("alert").filter({ hasText: "Move or remove furnishings" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Building floors", exact: true })).toHaveValue("2");
    const invalid = structuredClone(third!.definition); invalid.objects[0].structure.floors.pop(); invalid.objects[0].height = 5;
    const rejected = await page.request.post(`/api/world/${sid}/places/${pid}/scene`, { data: { action: "preview", base_revision: 3, definition: invalid } });
    expect(rejected.status()).toBe(400);
    expect((await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid }))!.revision).toBe(3);
    await page.getByRole("button", { name: "Upper bench bench", exact: true }).click();
    await page.getByRole("combobox", { name: "Object floor", exact: true }).selectOption(ground);
    await save(4);
    const fourth = await db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
    expect(fourth!.definition.objects[1].placement.floor_id).toBe(ground);
    expect((await db.collection("world_map").findOne({ _id: sid as never }))!.entities.find((o: { id: string }) => o.id === bench.id).elevation).toBe(0.015);
    await page.getByRole("button", { name: "Upper bench bench", exact: true }).click();
    await page.getByRole("combobox", { name: "Object floor", exact: true }).selectOption("");
    await expect(page.getByRole("combobox", { name: "Object floor", exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Object floor", exact: true })).toHaveValue(ground);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("combobox", { name: "Editing floor", exact: true }).selectOption(upper); await ready();
    await page.getByRole("combobox", { name: "Component type" }).selectOption("barrels");
    await page.getByRole("button", { name: "Draw footprint", exact: true }).click();
    const planCanvas = page.getByTestId("place-viewport").locator("canvas"); await planCanvas.scrollIntoViewIfNeeded();
    const box = (await planCanvas.boundingBox())!, half = Math.max(21, 21 * box.height / box.width);
    const point = (x: number, z: number) => ({ x: box.x + box.width / 2 + (x - 20) * box.height / (2 * half), y: box.y + box.height / 2 + (z - 20) * box.height / (2 * half) });
    const a = point(25.5, 20.5), b = point(26.5, 21.5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
    await expect(page.getByRole("button", { name: "Draw footprint", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("combobox", { name: "Object floor", exact: true })).toHaveValue(upper);
    expect(Number(await page.getByRole("spinbutton", { name: "Object x", exact: true }).inputValue())).toBeCloseTo(1, 1);
    expect(Number(await page.getByRole("spinbutton", { name: "Object z", exact: true }).inputValue())).toBeCloseTo(-2, 1);
    expect(Number(await page.getByRole("spinbutton", { name: "Object rotation", exact: true }).inputValue())).toBe(-90);
    await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Barrels barrels", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Revision 4" })).toHaveText("Revision 4 · Saved");
    const zipRes = await page.request.get(`/api/export/session/${sid}`); expect(zipRes.status()).toBe(200);
    const zip = await JSZip.loadAsync(await zipRes.body()), scenes = JSON.parse(await zip.file("place-scenes.json")!.async("string"));
    expect(scenes.find((s: { revision: number }) => s.revision === 4).definition).toEqual(fourth!.definition);
    const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${sid}/fork`);
    await page.getByRole("button", { name: "Fork world", exact: true }).click();
    const fork = await (await forkResponse).json(); if (!created.includes(fork.session_id)) created.push(fork.session_id);
    await expect(page).toHaveURL(new RegExp(`world=${fork.session_id}`)); await ready();
    expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id, place_id: pid }))!.definition).toEqual(fourth!.definition);
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
