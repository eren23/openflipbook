/**
 * Records the landing-page demo clip.
 *
 * Flow: http://localhost:3000/  →  click "how does a steam engine work" chip
 *  →  wait for first rendered page  →  click image (boiler region)
 *  →  wait for next page  →  click image (piston region)  →  wait  →  stop.
 *
 * Output:
 *   scripts/record-demo/artifacts/*.webm   (Playwright raw capture, gitignored)
 *   apps/web/public/demo.mp4              (re-encoded by ffmpeg, committed)
 *   apps/web/public/demo-poster.jpg       (single poster frame, committed)
 *
 * Usage (from repo root):
 *   docker compose up -d --build      # stack must be up on localhost:3000
 *   pnpm record-demo                  # delegates to this script
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ARTIFACTS = path.join(HERE, "artifacts");
const PUBLIC_DIR = path.join(REPO_ROOT, "apps", "web", "public");
const MP4_OUT = path.join(PUBLIC_DIR, "demo.mp4");
const POSTER_OUT = path.join(PUBLIC_DIR, "demo-poster.jpg");

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const VIEWPORT = { width: 1280, height: 800 };
const FIRST_PAGE_TIMEOUT_MS = 90_000;
const NEXT_PAGE_TIMEOUT_MS = 90_000;

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
    );
    child.on("error", reject);
  });
}

async function waitForFinalImageSrc(page: Page, timeoutMs: number): Promise<string> {
  const img = page.locator('img[alt^="Generated illustration"]');
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
  throw new Error("Timed out waiting for page image to stabilize");
}

async function clickOnImage(
  page: Page,
  xPct: number,
  yPct: number
): Promise<void> {
  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  if (!box) throw new Error("No bounding box for image");
  await page.mouse.click(box.x + box.width * xPct, box.y + box.height * yPct, {
    delay: 60,
  });
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: ARTIFACTS, size: VIEWPORT },
  });
  const page = await context.newPage();

  page.on("console", (msg: import("playwright").ConsoleMessage) => {
    if (msg.type() === "error") console.error("[browser]", msg.text());
  });

  console.log(`[record] opening ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  console.log("[record] clicking steam-engine chip");
  await page.getByRole("link", { name: "how does a steam engine work" }).click();
  await page.waitForURL(/\/play\?q=/);

  console.log("[record] waiting for first page to stabilize");
  const firstSrc = await waitForFinalImageSrc(page, FIRST_PAGE_TIMEOUT_MS);
  await page.waitForTimeout(800);

  console.log("[record] first click on image (boiler area)");
  await clickOnImage(page, 0.35, 0.55);

  console.log("[record] waiting for page to change after first click");
  await page
    .locator('img[alt^="Generated illustration"]')
    .first()
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    (prev: string) => {
      const el = document.querySelector('img[alt^="Generated illustration"]');
      return !!el && el.getAttribute("src") !== prev;
    },
    firstSrc,
    { timeout: NEXT_PAGE_TIMEOUT_MS }
  );
  const secondSrc = await waitForFinalImageSrc(page, NEXT_PAGE_TIMEOUT_MS);
  await page.waitForTimeout(800);

  console.log("[record] second click on image (piston area)");
  await clickOnImage(page, 0.65, 0.5);

  console.log("[record] waiting for page to change after second click");
  await page.waitForFunction(
    (prev: string) => {
      const el = document.querySelector('img[alt^="Generated illustration"]');
      return !!el && el.getAttribute("src") !== prev;
    },
    secondSrc,
    { timeout: NEXT_PAGE_TIMEOUT_MS }
  );
  await waitForFinalImageSrc(page, NEXT_PAGE_TIMEOUT_MS);
  await page.waitForTimeout(1500);

  await page.close();
  await context.close();
  await browser.close();

  const files = await readdir(ARTIFACTS);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("No .webm produced");
  const webmPath = path.join(ARTIFACTS, webm);
  console.log(`[record] raw video: ${webmPath}`);

  // The raw capture is long because each generation hop takes tens of seconds.
  // Speed up 4x so the embedded clip lands around 30-40 s while still showing
  // the generation-stream → click → generation-stream → click cadence.
  const SPEEDUP_PTS = "0.25";
  console.log(`[record] transcoding to ${MP4_OUT} (${SPEEDUP_PTS}x PTS)`);
  await run("ffmpeg", [
    "-y",
    "-i",
    webmPath,
    "-filter:v",
    `setpts=${SPEEDUP_PTS}*PTS`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "24",
    "-preset",
    "slow",
    "-movflags",
    "+faststart",
    "-an",
    MP4_OUT,
  ]);

  console.log(`[record] extracting poster frame to ${POSTER_OUT}`);
  await run("ffmpeg", [
    "-y",
    "-i",
    webmPath,
    "-ss",
    "00:00:02",
    "-vframes",
    "1",
    "-q:v",
    "3",
    POSTER_OUT,
  ]);

  console.log("[record] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
