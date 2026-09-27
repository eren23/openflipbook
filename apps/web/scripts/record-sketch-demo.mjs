import { chromium } from "@playwright/test";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

if (process.env.SKETCH_LIVE_DEMO !== "1")
  throw new Error("Requires SKETCH_LIVE_DEMO=1; makes one paid generation");
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:3003";
if (new URL(base).hostname !== "127.0.0.1") throw new Error("Local demo only");
const output = resolve(
  process.env.SKETCH_DEMO_OUTPUT ||
    "../../docs/research/assets/sketch-trials/native-demo",
);
await mkdir(output, { recursive: true });
const receipt = resolve(output, "receipt.json");
try {
  await access(receipt);
  throw new Error("Demo receipt exists; refusing another charge");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const record = { status: "started", reservation_usd: 0.3, mock: false };
try {
  await page.goto(`${base}/sketch`);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(
      "../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg",
    );
  await page.getByRole("heading", { name: "Draw a correction" }).waitFor();
  await page.getByRole("radio", { name: "Rectangle", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Sketch title" })
    .fill("Harbor - Ruby Beacon");
  await page
    .getByRole("textbox", { name: "Your changes" })
    .fill(
      "Change the cyan crystal on the left lighthouse to glowing ruby red. Keep its shape and the entire harbor unchanged. Remove annotation marks.",
    );
  await page
    .getByRole("button", { name: "Rectangle region", exact: true })
    .click();
  const box = await page.getByTestId("sketch-canvas").boundingBox();
  const scale = Math.min(1, (1440 - 380) / 1376, (1000 - 360) / 768);
  const left = box.x + box.width / 2 - (1376 * scale) / 2;
  const top = box.y + box.height / 2 - (768 * scale) / 2;
  // Slightly generous region includes the entire visible crystal and its glow.
  await page.mouse.move(left + 105 * scale, top + 25 * scale);
  await page.mouse.down();
  await page.mouse.move(left + 275 * scale, top + 245 * scale, { steps: 30 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save drawing", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Bundle", exact: true }).click();
  const bundle = await downloadPromise;
  await bundle.saveAs(resolve(output, "harbor.ofb-sketch"));
  const zip = await JSZip.loadAsync(
    await readFile(resolve(output, "harbor.ofb-sketch")),
  );
  for (const name of ["preview.png", "mask.png", "sketch.json"])
    await writeFile(
      resolve(output, name),
      await zip.file(name).async("nodebuffer"),
    );
  const scene = JSON.parse(await zip.file("sketch.json").async("string"));
  const mask = scene.scene.elements.find((e) => e.customData?.role === "mask");
  if (
    !mask ||
    mask.x > 140 ||
    mask.y > 70 ||
    mask.x + mask.width < 245 ||
    mask.y + mask.height < 170
  )
    throw new Error("Drawn mask misses the crystal; no generation submitted");
  await page.screenshot({ path: resolve(output, "drawing.png") });
  record.url = page.url();
  record.draft_id = new URL(page.url()).searchParams.get("id");
  await writeFile(receipt, JSON.stringify(record, null, 2));
  const resultPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/generate-page") && r.request().method() === "POST",
    { timeout: 900000 },
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const response = await resultPromise;
  const result = await response.json();
  if (!response.ok() || result.candidate?.mock)
    throw new Error(result.error || "Live backend returned mock/error");
  record.candidate = result.candidate;
  await page
    .getByRole("button", { name: "Keep Version", exact: true })
    .waitFor();
  await page
    .getByAltText("Generated candidate")
    .evaluate((image) => image.decode());
  await page
    .getByRole("slider", { name: "Before and after comparison" })
    .fill("0");
  await page.screenshot({ path: resolve(output, "result.png") });
  await page.getByRole("button", { name: "Keep Version", exact: true }).click();
  await page.getByRole("link", { name: "Open in World" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("link", { name: "Open in World" }).waitFor();
  record.status = "complete";
  record.errors = errors;
  await mkdir("test-results", { recursive: true });
  await context.storageState({
    path: resolve("test-results/sketch-demo-owner-state.private.json"),
  });
} catch (error) {
  record.status = "failed";
  record.error = String(error);
  await page.screenshot({ path: resolve(output, "failed.png") });
} finally {
  await writeFile(receipt, JSON.stringify(record, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify(record));
if (record.status !== "complete") process.exitCode = 1;
