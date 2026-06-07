/**
 * Records a standalone clip of EXPAND = map-pan (the `EXPAND_MAP_PAN` feature).
 *
 * Flow: http://localhost:3000/play  →  pick Storybook  →  type a coastal scene
 *  →  Go  →  wait for the page  →  press "Around"  →  wait for the 4 directional
 *  pans to bloom into the tray  →  hold a beat  →  tap "Westward"  →  wait for
 *  the world to pan  →  stop.
 *
 * Output (NOT the committed landing video — map-pan is flag-gated off in prod):
 *   scripts/record-demo/artifacts-mappan/*.webm   (raw capture)
 *   scripts/record-demo/mappan-demo.mp4           (4x-sped re-encode)
 *
 * Needs the stack up on :3000 with EXPAND_MAP_PAN=true (the demo override).
 * Usage (from repo root):
 *   scripts/record-demo/node_modules/.bin/tsx scripts/record-demo/record-mappan.ts
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-mappan");
const MP4_OUT = path.join(HERE, "mappan-demo.mp4");

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const VIEWPORT = { width: 1280, height: 800 };
const PAGE_TIMEOUT_MS = 120_000;
const QUERY = "a sprawling coastal fishing village at golden hour, wide aerial map view";

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
    );
    child.on("error", reject);
  });
}

async function waitForStableImage(page: Page, timeoutMs: number): Promise<string> {
  const img = page.locator('img[alt^="Generated illustration"]').first();
  await img.waitFor({ state: "visible", timeout: timeoutMs });
  let lastSrc = "";
  let stableSince = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const src = (await img.getAttribute("src")) ?? "";
    if (src && src === lastSrc) {
      if (Date.now() - stableSince >= 2500) return src;
    } else {
      lastSrc = src;
      stableSince = Date.now();
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for image to stabilize");
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: ARTIFACTS, size: VIEWPORT },
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[browser]", msg.text());
  });

  console.log(`[record] opening ${BASE_URL}/play`);
  await page.goto(`${BASE_URL}/play`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  console.log("[record] picking Storybook style");
  await page.getByRole("button", { name: "Storybook" }).click();

  console.log("[record] typing the scene query");
  await page.getByRole("textbox").first().fill(QUERY);
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Go" }).click();

  console.log("[record] waiting for the page to render");
  const parentSrc = await waitForStableImage(page, PAGE_TIMEOUT_MS);
  await page.waitForTimeout(1200);

  console.log("[record] pressing Around (fan out 4 map-pans)");
  await page.getByRole("button", { name: "Around" }).first().click();

  console.log("[record] waiting for the 4 directional pans to bloom");
  await page
    .getByRole("button", { name: "Explore Westward" })
    .waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
  // Hold a beat so the viewer takes in all four directions.
  await page.waitForTimeout(2600);

  console.log("[record] tapping Westward — pan the world");
  await page.getByRole("button", { name: "Explore Westward" }).click();
  await page.waitForFunction(
    (prev: string) => {
      const el = document.querySelector('img[alt^="Generated illustration"]');
      return !!el && el.getAttribute("src") !== prev;
    },
    parentSrc,
    { timeout: PAGE_TIMEOUT_MS }
  );
  await waitForStableImage(page, PAGE_TIMEOUT_MS);
  await page.waitForTimeout(2200);

  await page.close();
  await context.close();
  await browser.close();

  const files = await readdir(ARTIFACTS);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("No .webm produced");
  const webmPath = path.join(ARTIFACTS, webm);

  // Each gen/outpaint hop takes tens of seconds — speed up 4x like the landing
  // clip so the result lands around 25-30 s.
  console.log(`[record] transcoding ${webmPath} → ${MP4_OUT} (4x)`);
  await run("ffmpeg", [
    "-y", "-i", webmPath,
    "-filter:v", "setpts=0.25*PTS",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-crf", "24", "-preset", "slow",
    "-movflags", "+faststart", "-an",
    MP4_OUT,
  ]);

  console.log(`[record] done → ${MP4_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
