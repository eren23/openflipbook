/**
 * Records a FRESH world-mode navigation clip by actually driving the live app:
 *   enable World Mode  →  describe a place  →  the solved top-down map renders
 *   →  geo coordinate overlay  →  TAP IN to a place (the geometry box, not a
 *   blind coordinate)  →  step back via the breadcrumb  →  OUTWARD (zoom out
 *   to the surrounding container)  →  Around (map-pan bloom)  →  atlas.
 *
 * Needs the stack on localhost:3000 with the world flags on (WORLD_MODE,
 * GEOMETRIC_WORLD, WORLD_GEOMETRY_GEN, WORLD_FROM_DESCRIPTION, SCALE_LADDER_NAV,
 * SCALE_OUTWARD, EXPAND_MAP_PAN).
 *
 *   DEMO_BASE_URL=http://localhost:3000 DEMO_TAP_LABEL=castle pnpm tsx record-fresh-nav.ts
 *
 * The two CORE beats (map render, enter render) fail LOUD — a dead stack exits
 * 1 with a screenshot instead of producing a junk mp4. The tour beats
 * (outward / around / atlas) soft-skip with a warning.
 *
 * Output: scripts/record-demo/fresh-nav-demo.mp4
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-fresh-nav");
const MP4_OUT = path.join(HERE, "fresh-nav-demo.mp4");
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const TAP_LABEL = (process.env.DEMO_TAP_LABEL ?? "castle").toLowerCase();
const GEN_TIMEOUT = Number(process.env.DEMO_GEN_TIMEOUT_MS ?? 180_000);
const VIEWPORT = { width: 1280, height: 800 };
const DESC =
  "A walled harbor city seen from above: a tall striped lighthouse on the north cliff, " +
  "a market square in the center, wooden docks with fishing boats along the south shore, " +
  "and a stone castle on the east hill.";

const wait = (p: Page, ms: number) => p.waitForTimeout(ms);
const log = (m: string) => console.log(`[fresh-nav] ${m}`);

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "inherit" });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
    c.on("error", reject);
  });
}

/** A CORE generation wait: on timeout, screenshot + exit 1 — never a junk mp4. */
async function mustHappen(page: Page, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const shot = path.join(ARTIFACTS, `FAILED-${what.replace(/\W+/g, "-")}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    console.error(`[fresh-nav] FAILED waiting for ${what} — screenshot: ${shot}`);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Tap target: the geometry overlay's box for TAP_LABEL (the entity's REAL
 * detected coordinates), falling back to the prompt's expected spot. */
async function tapPoint(page: Page, img: Locator): Promise<{ x: number; y: number }> {
  const boxes = page.locator('[data-testid="geo-box"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    const label = ((await b.locator("span").first().textContent()) ?? "").toLowerCase();
    if (label.includes(TAP_LABEL)) {
      const bb = await b.boundingBox();
      if (bb) {
        log(`tapping the geometry box "${label.trim()}"`);
        return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
      }
    }
  }
  log(`WARN: no geo-box matching "${TAP_LABEL}" — falling back to the fixed east-hill spot`);
  const bb = await img.boundingBox();
  if (!bb) throw new Error("map image has no bounding box");
  return { x: bb.x + bb.width * 0.72, y: bb.y + bb.height * 0.34 };
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

  log("open /play");
  await page.goto(`${BASE}/play`, { waitUntil: "networkidle" });
  await wait(page, 1500);

  log("enable World Mode");
  await page.getByRole("button", { name: "world" }).first().click();
  await wait(page, 800);

  log("type the place description");
  await page.getByRole("textbox").first().fill(DESC);
  await wait(page, 600);

  log("lock a Woodcut style");
  await page.getByRole("button", { name: "Woodcut" }).first().click().catch(() => {});
  await wait(page, 800);

  log("Describe a place → solve + render the map");
  await page.getByRole("button", { name: /Describe a place/ }).first().click();
  const img = page.locator('img[alt^="Generated illustration"]').first();
  // CORE beat: the map must actually render.
  await mustHappen(page, "map-render", async () => {
    await page.waitForURL(/\/n\//, { timeout: GEN_TIMEOUT });
    await img.waitFor({ state: "visible", timeout: GEN_TIMEOUT });
  });
  await wait(page, 4000);

  log("geo coordinate overlay");
  const geo = page.getByRole("button", { name: /geo$/ }).first();
  if (await geo.count()) {
    await geo.click().catch(() => {});
    await wait(page, 4500);
  }

  log(`TAP IN — enter "${TAP_LABEL}"`);
  const mapUrl = page.url();
  const pt = await tapPoint(page, img);
  await page.mouse.move(pt.x, pt.y);
  await wait(page, 900);
  await page.mouse.click(pt.x, pt.y);
  // CORE beat: entering must resolve + render a NEW node (the conditioned
  // enter-edit — the consistency fix this clip exists to show).
  await mustHappen(page, "enter-render", async () => {
    await page.waitForURL((u) => u.toString() !== mapUrl && /\/n\//.test(u.toString()), {
      timeout: GEN_TIMEOUT,
    });
    await page
      .locator('img[alt^="Generated illustration"]')
      .first()
      .waitFor({ state: "visible", timeout: GEN_TIMEOUT });
  });
  log("entered the place — holding so the continuity reads on camera");
  await wait(page, 7000);

  log("step back to the map via the breadcrumb");
  const crumb = page.getByTestId("breadcrumb").locator("button").first();
  if (await crumb.count()) {
    await crumb.click().catch(() => {});
    await wait(page, 4500);
  } else {
    log("WARN: no breadcrumb — skipping step-back");
  }

  log("OUTWARD — zoom out to the surrounding container (edit-routed)");
  const outward = page.getByRole("button", { name: /zoom out|step back/i }).first();
  if (await outward.count()) {
    const beforeOut = page.url();
    await outward.click().catch(() => {});
    const moved = await page
      .waitForURL((u) => u.toString() !== beforeOut, { timeout: GEN_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    if (moved) {
      await page
        .locator('img[alt^="Generated illustration"]')
        .first()
        .waitFor({ state: "visible", timeout: GEN_TIMEOUT })
        .catch(() => {});
      await wait(page, 6000);
    } else {
      log("WARN: OUTWARD didn't navigate — continuing the tour");
    }
  } else {
    log("WARN: no OUTWARD button (root-only) — skipping");
  }

  log("Around — bloom the world around this page (map-pan)");
  const around = page.getByRole("button", { name: /Around/ }).first();
  if (await around.count()) {
    await around.click().catch(() => {});
    // The bloom streams panels into the tray; hold long enough for the first
    // pan(s) to land on camera, then move on.
    await wait(page, 28_000);
  } else {
    log("WARN: no Around button — skipping");
  }

  log("atlas — the nested world, zoom out then in");
  const atlas = page.getByRole("button", { name: /^atlas$/i }).first();
  if (await atlas.count()) {
    await atlas.click().catch(() => {});
    await wait(page, 3500);
    await page.mouse.move(VIEWPORT.width * 0.45, VIEWPORT.height * 0.45);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -120);
      await wait(page, 140);
    }
    await wait(page, 2500);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 120);
      await wait(page, 140);
    }
    await wait(page, 2500);
  }

  await page.close();
  await context.close();
  await browser.close();

  const webm = (await readdir(ARTIFACTS)).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no webm captured");
  log(`transcoding ${webm} → mp4 (1.6x)`);
  await run("ffmpeg", [
    "-y", "-i", path.join(ARTIFACTS, webm),
    "-filter:v", "setpts=0.625*PTS",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "slow",
    "-movflags", "+faststart", "-an",
    MP4_OUT,
  ]);
  log(`done → ${MP4_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
