import { expect, test, type Page } from "@playwright/test";
import { ankhStreetScene } from "../lib/ankh-scene";

test.skip(process.env.E2E_WORLD_SCENES !== "1", "Opt-in local linked sketch/3D checks");

test("retains the last pixels while replacement textures load", async ({ page }) => {
  const definition = ankhStreetScene(); definition.material_pack = "ankh-street-v1";
  await page.route("**/api/world/scene-context?**", route => route.fulfill({ json: { session_id: "fixture", place_id: "fixture", source_node_id: "fixture", source_url: "", initial: definition, scene: null, history: [], drawing: null } }));
  let delay = false, pending = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/material-atlas.png", async route => { if (delay) { pending++; await gate; } await route.continue(); });
  try {
    await page.goto("/sketch/world?source=fixture&view=split");
    await expect(page.getByTestId("place-viewport")).toHaveCount(2);
    for (const viewport of await page.getByTestId("place-viewport").all()) await expect(viewport).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: "The Mended Drum tavern", exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visiblePixels = () => page.getByTestId("place-viewport").evaluateAll(views => views.map(view => [...view.querySelectorAll("canvas")].filter(c => getComputedStyle(c).visibility === "visible").map(c => c.toDataURL())));
    const before = await visiblePixels(); expect(before).toHaveLength(2); expect(before.every(frames => frames.length === 1)).toBe(true);
    delay = true; await page.getByRole("spinbutton", { name: "Object width", exact: true }).fill("9.4");
    await expect.poll(() => pending).toBeGreaterThan(0);
    expect(await visiblePixels()).toEqual(before);
    release();
    for (const viewport of await page.getByTestId("place-viewport").all()) { await expect(viewport).toHaveAttribute("data-ready", "true"); await expect(viewport.locator("canvas")).toHaveCount(1); }
    const after = await visiblePixels(); expect(after[0]).not.toEqual(before[0]); expect(after[1]).not.toEqual(before[1]);
  } finally { release(); }
});

async function draw(page: Page, start: [number, number], end: [number, number]) {
  await page.getByRole("region", { name: "Live plan", exact: true }).scrollIntoViewIfNeeded();
  const box = (await page.getByRole("region", { name: "Live plan", exact: true }).locator("canvas").boundingBox())!;
  const half = Math.max(13, 21 * box.height / box.width);
  const point = ([x, z]: [number, number]) => ({ x: box.x + box.width / 2 + (x - 20) * box.height / (2 * half), y: box.y + box.height / 2 + (z - 12) * box.height / (2 * half) });
  const a = point(start), b = point(end);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 16 });
  await page.mouse.up();
}

for (const width of [1440, 390]) test(`draw, resize, cancel and undo share both views at ${width}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.goto("/sketch/world?demo=ankh&view=split");
  const viewports = page.getByTestId("place-viewport");
  const ready = async () => { await expect(viewports).toHaveCount(2); for (const p of await viewports.all()) await expect(p).toHaveAttribute("data-ready", "true"); };
  const pixels = () => viewports.locator("canvas").evaluateAll(canvases => canvases.map(c => (c as HTMLCanvasElement).toDataURL()));
  await ready(); const before = await pixels();
  await page.getByRole("combobox", { name: "Component type" }).selectOption("house");
  await page.getByRole("button", { name: "Draw footprint", exact: true }).click();
  await draw(page, [21, 13], [24, 16]); await ready();
  // Browser pointer coordinates and canvas CSS pixels have sub-pixel rounding.
  await expect.poll(async () => Math.abs(Number(await page.getByRole("spinbutton", { name: "Object width", exact: true }).inputValue()) - 3)).toBeLessThan(0.02);
  expect(Math.abs(Number(await page.getByRole("spinbutton", { name: "Object depth", exact: true }).inputValue()) - 3)).toBeLessThan(0.02);
  const originalWidth = await page.getByRole("spinbutton", { name: "Object width", exact: true }).inputValue();
  await expect(page.getByRole("button", { name: "Draw footprint", exact: true })).toHaveAttribute("aria-pressed", "false");
  const added = await pixels(); expect(added[0]).not.toBe(before[0]); expect(added[1]).not.toBe(before[1]);
  const selected = await viewports.first().getAttribute("data-selected");
  expect(selected).toBeTruthy(); await expect(viewports.last()).toHaveAttribute("data-selected", selected!);
  const cameraBefore = await viewports.last().getAttribute("data-camera");
  await page.getByRole("button", { name: "Frame selected in 3D", exact: true }).click();
  await expect(viewports.last()).not.toHaveAttribute("data-camera", cameraBefore!);
  await page.getByRole("textbox", { name: "Object name", exact: true }).fill("Filigree workshop");
  await page.getByRole("spinbutton", { name: "Object width", exact: true }).fill("2.5"); await ready();
  const resized = await pixels(); expect(resized[0]).not.toBe(added[0]); expect(resized[1]).not.toBe(added[1]);
  await page.getByRole("button", { name: "Undo draft edit", exact: true }).click(); await ready();
  await expect(page.getByRole("spinbutton", { name: "Object width", exact: true })).toHaveValue(originalWidth);
  await page.getByRole("button", { name: "Draw footprint", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Draw footprint", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Plan + 3D", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/world-sketch-added-${width}.png`, fullPage: true });
  if (width === 390) {
    const lastView = (await viewports.last().boundingBox())!, inspector = (await page.getByRole("complementary").boundingBox())!;
    expect(lastView.y + lastView.height).toBeLessThanOrEqual(inspector.y);
  }
  await page.getByRole("button", { name: "Remove object", exact: true }).click(); await ready();
  await expect(page.getByRole("button", { name: "Filigree workshop house", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const p of await viewports.all()) {
    const box = (await p.boundingBox())!; expect(box.width).toBeGreaterThan(150); expect(box.height).toBeGreaterThan(150);
  }
  await page.screenshot({ path: `test-results/world-sketch-sync-${width}.png`, fullPage: true });
  expect(errors).toEqual([]);
});
