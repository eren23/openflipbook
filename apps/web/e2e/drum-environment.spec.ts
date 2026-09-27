import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_DRUM_ENVIRONMENT !== "1", "Opt-in environment proof");
test("capture the fixed camera geometry guide", async ({ page }) => {
  test.skip(process.env.E2E_CAPTURE_DRUM_GUIDE !== "1", "Do not overwrite the generation input during UI checks");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/sketch/world/ankh?capture=1");
  const guide = page.getByTestId("environment-guide");
  await expect(guide).toHaveAttribute("data-ready", "true");
  await mkdir("public/demos/ankh-morpork", { recursive: true });
  await guide.locator("canvas").screenshot({ path: "public/demos/ankh-morpork/street-geometry-guide.png" });
});

for (const width of [1440, 390]) test(`image-first map, saved edit and native Sketch ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const errors: string[] = [], generations: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/generate-page", route => { generations.push(route.request().url()); return route.abort(); });
  await page.goto("/sketch/world/ankh");
  const map = page.getByAltText("Ankh-Morpork city map");
  await map.evaluate(img => (img as HTMLImageElement).decode());
  await page.getByRole("button", { name: "Focus Mended Drum", exact: true }).click();
  await expect.poll(() => map.evaluate(img => getComputedStyle(img).transform)).toBe("matrix(4, 0, 0, 4, 0, 0)");
  await page.getByRole("button", { name: "Enter the Drum's street", exact: true }).click();
  await page.getByAltText("The Mended Drum on Filigree Street").evaluate(img => (img as HTMLImageElement).decode());
  expect(await page.getByAltText("The Mended Drum on Filigree Street").evaluate(img => getComputedStyle(img).transform)).toBe("none");
  await page.getByRole("button", { name: "Inspect landmarks", exact: true }).click();
  await page.getByRole("button", { name: "Front door", exact: true }).click();
  await expect(page.locator("footer")).toContainText("Front door");
  await page.getByRole("button", { name: "Inspect landmarks", exact: true }).click();
  await page.getByRole("button", { name: "Teal roof", exact: true }).click();
  const edited = page.getByAltText("The Mended Drum with its saved teal roof edit");
  await edited.evaluate(img => (img as HTMLImageElement).decode());
  await expect(edited).toHaveAttribute("src", "/demos/ankh-morpork/street-edit.png");
  await expect(page.getByRole("link", { name: "Edit in Sketch", exact: true })).toHaveAttribute("href", "/sketch?example=drum-teal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const buttons = await page.locator("button,a").evaluateAll(elements => elements.map(el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom, width: b.width }; }).filter(b => b.width));
  for (const bounds of buttons) { expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); expect(bounds.bottom).toBeLessThanOrEqual(width === 390 ? 844 : 1000); }
  await mkdir(`test-results/drum-${width}`, { recursive: true });
  await page.screenshot({ path: `test-results/drum-${width}/street.png` });
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await page.getByRole("link", { name: "Edit in Sketch", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Sketch title" })).toHaveValue("The Mended Drum / roof material");
  if (width === 390) await page.getByRole("button", { name: "Generation settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Image model" })).toHaveValue("nano");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  if (width === 390) await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("radio", { name: "Rectangle", exact: true }).waitFor();
  await page.screenshot({ path: `test-results/drum-${width}/sketch.png` });
  expect(errors).toEqual([]); expect(generations).toEqual([]);
});
