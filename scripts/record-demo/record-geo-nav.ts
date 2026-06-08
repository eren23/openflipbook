/**
 * Records the geometric-world STRUCTURE clip on an already-rich session — no slow
 * generations, just the navigation + atlas the build added:
 *   continue a session  →  coordinate overlay (numeric world + minimap)
 *   →  breadcrumb UP a level  →  atlas: zoom OUT (nested chain) + zoom IN (a branch).
 *
 *   DEMO_BASE_URL=http://localhost:3137 GEO_SESSION=session_xxx \
 *     pnpm tsx scripts/record-demo/record-geo-nav.ts
 *
 * Output: scripts/record-demo/geo-nav-demo.mp4
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-geo-nav");
const MP4_OUT = path.join(HERE, "geo-nav-demo.mp4");
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3137";
const SESSION = process.env.GEO_SESSION ?? "";
const VIEWPORT = { width: 1280, height: 800 };

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "inherit" });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
    c.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (!SESSION) throw new Error("set GEO_SESSION=session_...");
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: ARTIFACTS, size: VIEWPORT },
  });
  const page: Page = await context.newPage();

  // Continue the session — lands on its latest node.
  await page.goto(`${BASE}/play?continue=${SESSION}`, { waitUntil: "networkidle" });
  await page.locator('img[alt^="Generated illustration"]').first()
    .waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(5000); // worldState + geoMap hydrate

  // Coordinate overlay — the numeric world + minimap.
  const geo = page.getByRole("button", { name: /geo$/ }).first();
  if ((await geo.count()) && (await geo.getAttribute("aria-pressed")) !== "true") {
    await geo.click();
  }
  await page.waitForTimeout(4500);

  // Breadcrumb UP a level (jump to the map / an ancestor).
  const crumbs = page.locator('[data-testid="breadcrumb"] button');
  if (await crumbs.count()) {
    await crumbs.first().click();
    await page.waitForTimeout(4000);
  }

  // Atlas — zoom OUT to the whole nested chain, then zoom IN on a branch.
  await page.goto(`${BASE}/atlas/${SESSION}`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const fit = page.getByRole("button", { name: /fit all/i }).first();
  if (await fit.count()) await fit.click().catch(() => {});
  await page.waitForTimeout(3500);
  await page.mouse.move(VIEWPORT.width * 0.3, VIEWPORT.height * 0.28);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -130);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(3500);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 130);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(2500);

  await page.close();
  await context.close();
  await browser.close();

  const webm = (await readdir(ARTIFACTS)).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no webm");
  // Light 1.5x speedup — it's already a tight nav clip.
  await run("ffmpeg", [
    "-y", "-i", path.join(ARTIFACTS, webm),
    "-filter:v", "setpts=0.66*PTS",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "slow",
    "-movflags", "+faststart", "-an",
    MP4_OUT,
  ]);
  console.log("[geo-nav] done →", MP4_OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
