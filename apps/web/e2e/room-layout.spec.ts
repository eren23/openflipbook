import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import JSZip from "jszip";

test.skip(process.env.E2E_ROOM_LAYOUT !== "1", "Real owned-world room editing and walking; no model calls");
for (const width of [1280, 390]) test(`connected rooms, stairs and saved identities at ${width}`, async ({ page, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local server required");
  process.loadEnvFile(".env.local"); const client = new MongoClient(process.env.MONGODB_URI!); await client.connect();
  const db = client.db(process.env.MONGODB_DB), created: string[] = [], errors: string[] = [], paid: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", async r => { if (r.ok() && r.request().method() === "POST" && /\/api\/creator\/worlds$|\/fork$/.test(new URL(r.url()).pathname)) { const data = await r.json(); if (data.session_id && !created.includes(data.session_id)) created.push(data.session_id); } });
  await page.route(/\/api\/(generate-page|sketches\/[^/]+\/generate|world\/[^/]+\/meshes)/, route => { if (route.request().method() !== "GET") { paid.push(route.request().url()); return route.abort(); } return route.continue(); });
  const viewport = page.getByTestId("place-viewport"), ready = () => expect(viewport).toHaveAttribute("data-ready", "true");
  const camera = async () => (await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const walk = async (key: string, axis: number, target: number, less: boolean) => {
    await page.keyboard.down(key);
    try { await expect.poll(async () => { const value = (await camera())[axis]!; return less ? value < target : value > target; }, { intervals: [30] }).toBe(true); }
    finally { await page.keyboard.up(key); }
  };
  const save = async (revision: number) => { await page.getByRole("button", { name: "Preview", exact: true }).click(); await page.getByRole("button", { name: "Apply to world", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: `Revision ${revision}` })).toHaveText(`Revision ${revision} · Saved`); await ready(); };
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto("/sketch/world"); await ready();
    await page.getByLabel("Place width", { exact: true }).fill("20"); await page.getByLabel("Place depth", { exact: true }).fill("20");
    await page.getByText("Entrance", { exact: true }).click(); await page.getByLabel("Entrance x", { exact: true }).fill("10"); await page.getByLabel("Entrance z", { exact: true }).fill("16");
    await page.getByRole("combobox", { name: "Component type" }).selectOption("building"); await page.getByRole("button", { name: "Add object", exact: true }).click();
    await page.getByRole("combobox", { name: "Building floors", exact: true }).selectOption("2");
    await page.getByRole("button", { name: "Create room layout", exact: true }).click();
    await page.getByRole("button", { name: "Split room", exact: true }).click();
    await page.getByRole("textbox", { name: "Room name", exact: true }).fill("Study");
    await expect(page.getByRole("spinbutton", { name: "Partition position", exact: true })).toHaveValue("1.5");
    await page.getByRole("combobox", { name: "Room layout floor", exact: true }).selectOption({ label: "Upper floor" });
    await page.getByRole("button", { name: "Create room layout", exact: true }).click();
    await page.getByRole("button", { name: "Split room", exact: true }).click();
    await page.getByRole("textbox", { name: "Room name", exact: true }).fill("Bedroom");
    await page.getByRole("spinbutton", { name: "Interior door width", exact: true }).fill("0.5");
    await expect(page.getByRole("alert").filter({ hasText: "Interior doorway lacks clearance" })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Interior door width", exact: true })).toHaveValue("1.2");
    await page.getByRole("combobox", { name: "Component type" }).selectOption("bench"); await page.getByRole("button", { name: "Add object", exact: true }).click();
    await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await save(1);
    const sid = new URL(page.url()).searchParams.get("world")!, pid = new URL(page.url()).searchParams.get("place")!; if (!created.includes(sid)) created.push(sid);
    const read = () => db.collection("place_scenes").findOne({ session_id: sid, place_id: pid });
    const first = await read(), building = first!.definition.objects[0], bench = first!.definition.objects[1], study = building.structure.floors[0].layout.b.id, bedroom = building.structure.floors[1].layout.b.id;
    expect(bench.placement.floor_id).toBe(building.structure.floors[1].id);
    expect((await db.collection("world_map").findOne({ _id: sid as never }))!.entities.find((g: { id: string }) => g.id === bench.id).room_id).toBe(bedroom);
    await viewport.scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/room-layout-${width}-plan.png` });
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await viewport.scrollIntoViewIfNeeded();
    await walk("w", 2, 12.3, true);
    await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
    expect((await camera())[0]).toBeLessThan(11.15);
    await walk("w", 2, 10.1, true); await walk("d", 0, 12.4, false);
    await expect(page.getByRole("status", { name: "Current room" })).toContainText("Study");
    const saved = () => db.collection("creator_worlds").findOne({ _id: sid as never });
    await expect.poll(async () => (await saved())?.walk_position?.pose?.space?.room_id).toBe(study);
    await page.reload(); await ready(); await expect(viewport).toHaveAttribute("data-pose-restore", "restored");
    await expect(page.getByRole("status", { name: "Current room" })).toContainText("Study");
    await walk("a", 0, 10.15, true); await walk("s", 2, 12.4, false); await walk("a", 0, 7.15, true);
    await page.waitForTimeout(150);
    for (let i = 0; i < 40; i++) { const x = (await camera())[0]!; if (Math.abs(x - 7.05) < 0.14) break; await page.keyboard.press(x > 7.05 ? "a" : "d", { delay: 5 }); await page.waitForTimeout(150); }
    await walk("w", 2, 6.3, true); expect((await camera())[1]).toBeGreaterThan(4.7);
    await walk("d", 0, 9.2, false); await walk("s", 2, 9.95, false); await walk("d", 0, 11.4, false);
    await expect(page.getByRole("status", { name: "Current room" })).toContainText("Bedroom");
    await expect.poll(async () => (await saved())?.walk_position?.pose?.space?.room_id).toBe(bedroom);
    const roomStatus = page.getByRole("status", { name: "Current room" });
    await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(350);
    const roomBox = (await roomStatus.boundingBox())!, sceneBox = (await viewport.boundingBox())!;
    expect(roomBox.y + roomBox.height).toBeLessThanOrEqual(sceneBox.y + 1);
    for (const name of ["Strafe left", "Walk forward", "Walk backward", "Strafe right", "Turn left", "Turn right"]) {
      const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(sceneBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(sceneBox.x + sceneBox.width);
      expect(box.y).toBeGreaterThanOrEqual(sceneBox.y);
      expect(box.y + box.height).toBeLessThanOrEqual(sceneBox.y + sceneBox.height);
    }
    // Spatial variation in one channel rejects a flat colored WebGL surface.
    const pixelRange = () => viewport.locator("canvas").evaluate(el => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d")!; context.drawImage(el as HTMLCanvasElement, 0, 0, 64, 64);
      const pixels = context.getImageData(0, 0, 64, 64).data; let min = 255, max = 0;
      for (let i = 0; i < pixels.length; i += 4) { min = Math.min(min, pixels[i]!); max = Math.max(max, pixels[i]!); }
      return max - min;
    });
    await expect.poll(pixelRange).toBeGreaterThan(25);
    await viewport.scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/room-layout-${width}-bedroom.png` });
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(); await page.getByRole("button", { name: "Building building", exact: true }).click();
    await page.getByRole("combobox", { name: "Room layout floor", exact: true }).selectOption({ label: "Upper floor" });
    await page.getByRole("combobox", { name: "Selected room", exact: true }).selectOption({ label: "Bedroom" });
    await page.getByRole("textbox", { name: "Room name", exact: true }).fill("Guest room"); await save(2);
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await expect(viewport).toHaveAttribute("data-pose-restore", "revalidated");
    await expect(page.getByRole("status", { name: "Current room" })).toContainText("Guest room");
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready(); await page.getByRole("button", { name: "Building building", exact: true }).click();
    await page.getByRole("button", { name: "Merge rooms", exact: true }).click(); await save(3);
    await page.getByRole("button", { name: "Walk", exact: true }).click(); await ready(); await expect(viewport).toHaveAttribute("data-pose-restore", "recovered");
    const current = await read(); expect(current!.definition.objects[0].structure.floors[1].layout.type).toBe("room");
    await page.getByRole("button", { name: "Plan", exact: true }).click(); await ready();
    const res = await page.request.get(`/api/export/session/${sid}`); expect(res.status()).toBe(200);
    const zip = await JSZip.loadAsync(await res.body()), scenes = JSON.parse(await zip.file("place-scenes.json")!.async("string")); expect(scenes.find((s: { revision: number }) => s.revision === 3).definition).toEqual(current!.definition);
    const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${sid}/fork` && r.request().method() === "POST"); await page.getByRole("button", { name: "Fork world", exact: true }).click();
    const fork = await (await forkResponse).json(); if (!created.includes(fork.session_id)) created.push(fork.session_id);
    await expect(page).toHaveURL(new RegExp(`world=${fork.session_id}`)); await ready();
    expect((await db.collection("place_scenes").findOne({ session_id: fork.session_id, place_id: pid }))!.definition).toEqual(current!.definition);
    expect(errors).toEqual([]); expect(paid).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.goto("about:blank");
    for (const sid of created) { for (const name of ["place_scenes", "place_scene_versions", "world_edit_proposals"]) await db.collection(name).deleteMany({ session_id: sid }); for (const name of ["world_map", "world_state", "session_owners", "creator_worlds"]) await db.collection(name).deleteOne({ _id: sid as never }); }
    await client.close();
  }
});
