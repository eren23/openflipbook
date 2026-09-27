/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { expect, test } from "@playwright/test";
import { ankhStreetScene } from "../lib/ankh-scene";
import { mapRepaintState } from "../lib/map-artwork";

test.skip(process.env.E2E_WORLD_SCENES !== "1", "Opt-in map artwork UI checks");
for (const width of [1440, 390]) test(`reviews geometry placement before preparing artwork at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const before = ankhStreetScene(), after = structuredClone(before);
  after.objects.find(o => o.kind === "tavern")!.roof_material = "teal";
  const scene = { id: "scene", place_id: "place", session_id: "world", revision: 3, definition: after };
  await page.route("**/api/world/scene-context?**", r => r.fulfill({ json: { session_id: "world", place_id: "place" } }));
  let submitted: any;
  await page.route("**/api/world/world/places/place/map-artwork", async r => {
    if (r.request().method() === "POST") { submitted = r.request().postDataJSON(); await r.fulfill({ status: 409, json: { error: "Geometry changed. Reload before repainting." } }); }
    else await r.fulfill({ json: { scene, baseline: { ...scene, revision: 1, definition: before }, map: { id: "map", root_id: "map", title: "Ankh-Morpork", url: "/demos/ankh-morpork/map.png" }, registration: null } });
  });
  await page.goto("/sketch/world/map?source=fixture");
  await expect(page.getByRole("img", { name: "Current parent map artwork" })).toBeVisible();
  const prepare = page.getByRole("button", { name: "Open repaint in Sketch" });
  await page.getByRole("spinbutton", { name: "Map width", exact: true }).fill("10.3");
  await expect(prepare).toBeDisabled();
  const confirm = page.getByRole("checkbox", { name: "Map placement reviewed (approximate)" });
  await confirm.check(); await expect(prepare).toBeEnabled();
  await page.getByRole("spinbutton", { name: "Map x", exact: true }).fill("45.3");
  await expect(confirm).not.toBeChecked(); await expect(prepare).toBeDisabled();
  await confirm.check(); await prepare.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Geometry changed");
  expect(submitted).toMatchObject({ scene_revision: 3, map_source_node_id: "map", confirmed: true, registration: { x: 45.3, width: 10.3 }, frame: { width: 1672, height: 941 } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/map-artwork-${width}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`keeps focused comparison images visible at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const before = ankhStreetScene(), after = structuredClone(before); after.objects.find(o => o.kind === "tavern")!.roof_material = "teal";
  const state = mapRepaintState(before, after, { x: 45.2, y: 59.3, width: 10.3, rotation: 0 }, { width: 1672, height: 941 }, 3);
  const draft = { id: "draft", session_id: "fixture", revision: 1, state, source_node_id: "map", source_url: "/demos/ankh-morpork/map.png", map_repaint: { scene_revision: 3, scene_source_node_id: "street" } };
  await page.route("**/api/sketches/draft", r => r.fulfill({ json: { sketch: draft, candidates: [{ id: "candidate", draft_id: "draft", revision: 1, status: "ready", image_url: "/demos/ankh-morpork/map.png", matches_draft: true, outside_changed: 0, mock: true }] } }));
  await page.route("**/api/generate-page", r => r.abort());
  await page.goto("/sketch?id=draft");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const focus = page.getByRole("button", { name: "Focus changed map area" });
  await expect(focus).toHaveAttribute("aria-pressed", "true");
  const image = page.getByRole("img", { name: "Generated candidate" });
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1672);
  const bounds = await image.evaluate(i => ({ image: i.getBoundingClientRect().toJSON(), container: i.parentElement!.getBoundingClientRect().toJSON(), maxWidth: getComputedStyle(i).maxWidth }));
  expect(bounds.maxWidth).toBe("none");
  expect(bounds.image.left).toBeLessThan(bounds.container.left); expect(bounds.image.right).toBeGreaterThan(bounds.container.right);
  expect(bounds.image.top).toBeLessThan(bounds.container.top); expect(bounds.image.bottom).toBeGreaterThan(bounds.container.bottom);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/map-artwork-compare-${width}.png`, fullPage: true });
  await focus.click(); await expect(focus).toHaveAttribute("aria-pressed", "false");
});
