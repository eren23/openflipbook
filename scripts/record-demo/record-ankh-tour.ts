/**
 * Ankh-Morpork "in AND out of buildings" tour — the full scale-navigation loop.
 *
 *   a richly-described Discworld city map (Vintage style, DOM labels)
 *   → coordinate overlay (the numeric world)
 *   → GO IN the Unseen University           (DEEPER / descend)
 *   → GO DEEPER inside it                    (DEEPER again)
 *   → STEP BACK OUT to the city map          (breadcrumb — "outside the building")
 *   → GO IN a different landmark             (in → out → in)
 *   → STEP BACK OUT again                    (breadcrumb)
 *   → AROUND                                  (bloom neighbours / pan the world)
 *   → OUTWARD: zoom out beyond the city       (ascend — the container of Ankh-Morpork)
 *   → atlas finale (the whole exploration tree).
 *
 * This is the sibling of record-ankh.ts: that one proves the EDIT path (ferry
 * inpaint); this one proves SCALE NAVIGATION both ways (in and out).
 *
 *   backend: docker stack on :8787 (WORLD_MODE + SCALE_* flags on)
 *   web:     docker stack on :3000 (NEXT_PUBLIC_WORLD_MODE baked on)
 *   DEMO_BASE_URL=http://localhost:3000 pnpm tsx scripts/record-demo/record-ankh-tour.ts
 *
 * CORE beats (map render, first enter, first step-out) fail LOUD with a
 * screenshot + exit 1. Tour beats (deeper, second enter, around, outward, atlas)
 * soft-skip with a warning so layout variance can't kill the clip.
 *
 * Output:
 *   scripts/record-demo/artifacts-tour/*.webm + NN-*.png   (raw)
 *   scripts/record-demo/ankh-tour.mp4                       (~2.5x speedup)
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-tour");
const MP4_OUT = path.join(HERE, "ankh-tour.mp4");

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const VIEWPORT = { width: 1280, height: 800 };
const GEN_TIMEOUT = Number(process.env.DEMO_GEN_TIMEOUT_MS ?? 300_000);

const QUERY =
  "A detailed top-down fantasy city map of Ankh-Morpork: the Unseen University " +
  "with its tall Tower of Art, the Patrician's Palace, the Brass Bridge crossing " +
  "the slow brown River Ankh, the Mended Drum tavern, the Shades' crooked alleys, " +
  "and wooden docks along the riverbank — each landmark clearly labelled, aged parchment.";

const log = (msg: string) => console.log(`[tour] ${msg}`);

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "inherit" });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
    c.on("error", reject);
  });
}

const img = (p: Page) => p.locator('img[alt^="Generated illustration"]').first();

let shotIdx = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotIdx += 1;
  const file = path.join(ARTIFACTS, `${String(shotIdx).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  log(`  📸 ${String(shotIdx).padStart(2, "0")}-${name}`);
}

async function mustHappen(page: Page, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const file = path.join(ARTIFACTS, `FAILED-${what.replace(/\W+/g, "-")}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    console.error(`[tour] FAILED ${what} — screenshot: ${file}`);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Wait for the displayed image to settle on a NEW src with no generating
 * banner up. Works for BOTH a fresh generation (banner appears then clears) and
 * a stored-node load via breadcrumb (no banner, src just swaps). */
async function waitSettled(page: Page, prev: string, timeout: number): Promise<string> {
  await img(page).waitFor({ state: "visible", timeout }).catch(() => {});
  const end = Date.now() + timeout;
  let lastSrc = "";
  let stableSince = 0;
  while (Date.now() < end) {
    const src = (await img(page).getAttribute("src")) ?? "";
    const generating = await page.getByTestId("generating-banner").count();
    if (src && src !== prev && generating === 0) {
      if (src === lastSrc) {
        if (Date.now() - stableSince >= 1500) return src;
      } else {
        lastSrc = src;
        stableSince = Date.now();
      }
    } else {
      lastSrc = "";
    }
    await page.waitForTimeout(500);
  }
  throw new Error("image never settled on a new src (banner up or src unchanged)");
}

async function landmarkPoint(
  page: Page,
  pattern: RegExp,
  fallback: { x: number; y: number },
): Promise<{ x: number; y: number; matched: string | null }> {
  const boxes = page.locator('[data-testid="geo-box"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    const label = ((await b.locator("span").first().textContent()) ?? "").toLowerCase();
    if (pattern.test(label)) {
      const bb = await b.boundingBox();
      if (bb) return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, matched: label.trim() };
    }
  }
  return { ...fallback, matched: null };
}

async function tapAt(page: Page, pt: { x: number; y: number }): Promise<void> {
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function contentPoint(
  page: Page,
  xFrac: number,
  yFrac: number,
): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(
    ([fx, fy]) => {
      const el = document.querySelector(
        'img[alt^="Generated illustration"]',
      ) as HTMLImageElement | null;
      if (!el || !el.naturalWidth || !el.naturalHeight) return null;
      const r = el.getBoundingClientRect();
      const naturalAspect = el.naturalWidth / el.naturalHeight;
      const boxAspect = r.width / r.height;
      let w = r.width;
      let h = r.height;
      let ox = 0;
      let oy = 0;
      if (naturalAspect > boxAspect) {
        h = r.width / naturalAspect;
        oy = (r.height - h) / 2;
      } else {
        w = r.height * naturalAspect;
        ox = (r.width - w) / 2;
      }
      return { x: r.left + ox + w * (fx as number), y: r.top + oy + h * (fy as number) };
    },
    [xFrac, yFrac],
  );
  if (!pt) throw new Error("image has no content rect");
  return pt;
}

async function waitForGeoBoxes(page: Page, timeout: number): Promise<void> {
  await page
    .locator('[data-testid="geo-box"]')
    .first()
    .waitFor({ state: "visible", timeout })
    .catch(() => log("WARN: no geo boxes appeared (extraction still pending?)"));
}

/** Step back OUT one or all levels via the breadcrumb. `which`="root" clicks the
 * leftmost crumb (the city map); "up" clicks the second-to-last (one level out). */
async function stepOut(
  page: Page,
  which: "root" | "up",
  prev: string,
): Promise<string> {
  const buttons = page.locator('[data-testid="breadcrumb"] button');
  const n = await buttons.count();
  if (n === 0) throw new Error("no breadcrumb ancestor buttons to step out to");
  const target = which === "root" ? buttons.first() : buttons.nth(Math.max(0, n - 1));
  const label = (await target.textContent())?.trim() ?? "?";
  log(`step out → "${label}"`);
  await target.click();
  return waitSettled(page, prev, 60_000);
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
  page.on("console", (m) => m.type() === "error" && console.error("[browser]", m.text()));

  // ── 1. Open + style + World Mode ────────────────────────────────────────────
  log("opening /play");
  // NOTE: "domcontentloaded", not "networkidle" — /play opens a persistent
  // change-stream SSE (shared-session read-along), so the network never idles.
  await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await mustHappen(page, "style-lock", () =>
    page.getByRole("button", { name: "Vintage" }).first().click({ timeout: 10_000 }),
  );
  await page.waitForTimeout(500);
  const world = page.getByRole("button", { name: "world" }).first();
  if ((await world.count()) && (await world.getAttribute("aria-pressed")) !== "true") {
    await world.click();
    log("world mode toggled ON");
  } else {
    log("world mode already ON (baked default)");
  }
  await page.waitForTimeout(500);

  // ── 2. The map (CORE) ───────────────────────────────────────────────────────
  log("describing Ankh-Morpork");
  const tb = page.getByRole("textbox").first();
  const go = page.getByRole("button", { name: "Go" }).first();
  const submitQuery = async (): Promise<boolean> => {
    await tb.click();
    await tb.fill(QUERY);
    await page.waitForTimeout(400);
    await go.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 30; i++) {
      if (await go.isEnabled()) break;
      await page.waitForTimeout(500);
    }
    await go.click();
    return page
      .getByText(/Resolving|Exploring|Planning page|Drawing|Generating/i)
      .first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
  };
  let cityMapSrc = "";
  await mustHappen(page, "map-render", async () => {
    let started = await submitQuery();
    if (!started) {
      log("WARN: generation did not start on first submit — retrying");
      started = await submitQuery();
    }
    if (!started) throw new Error("generation never started after the query submit");
    cityMapSrc = await waitSettled(page, "", GEN_TIMEOUT);
  });
  await page.waitForTimeout(2500);
  await shot(page, "city-map");

  // Session id for the atlas finale.
  let session: string | null = null;
  for (let i = 0; i < 30 && !session; i++) {
    session = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/atlas/"]');
      const m = (a?.getAttribute("href") ?? "").match(/\/atlas\/(session_[a-z0-9-]+)/i);
      return m ? m[1] : null;
    });
    if (!session) await page.waitForTimeout(1000);
  }
  log(`session: ${session}`);

  // ── 3. The numeric world (coordinate overlay) ───────────────────────────────
  log("coordinate overlay");
  const geo = page.getByRole("button", { name: /geo$/ }).first();
  if ((await geo.count()) && (await geo.getAttribute("aria-pressed")) !== "true") {
    await geo.click();
  }
  await waitForGeoBoxes(page, 25_000);
  await page.waitForTimeout(3500);
  await shot(page, "geo-overlay");

  // ── 4. GO IN the Unseen University (CORE) ───────────────────────────────────
  const uni = await landmarkPoint(page, /universit|tower/i, await contentPoint(page, 0.16, 0.35));
  log(`go IN: ${uni.matched ?? "fallback spot (no matching geo-box)"}`);
  await tapAt(page, uni);
  let insideSrc = "";
  await mustHappen(page, "enter-university", async () => {
    try {
      insideSrc = await waitSettled(page, cityMapSrc, GEN_TIMEOUT);
    } catch (e) {
      log(`enter failed once (${e instanceof Error ? e.message : e}) — re-tapping`);
      await tapAt(page, uni);
      insideSrc = await waitSettled(page, cityMapSrc, GEN_TIMEOUT);
    }
  });
  await page.waitForTimeout(3500);
  await shot(page, "inside-university");

  // ── 5. GO DEEPER inside it (tour) ───────────────────────────────────────────
  let deeperSrc = insideSrc;
  try {
    const deeper = await landmarkPoint(
      page,
      /hall|library|door|gate|stair|room|tower|desk|table|book/i,
      await contentPoint(page, 0.5, 0.55),
    );
    log(`go DEEPER: ${deeper.matched ?? "fallback spot"}`);
    await tapAt(page, deeper);
    deeperSrc = await waitSettled(page, insideSrc, GEN_TIMEOUT);
    await page.waitForTimeout(3500);
    await shot(page, "deeper-inside");
  } catch (e) {
    log(`WARN: deeper beat skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 6. STEP BACK OUT to the city map (CORE — "outside the building") ─────────
  await mustHappen(page, "step-out-to-city", async () => {
    const back = await stepOut(page, "root", deeperSrc);
    // We should be back on (or very near) the original city map.
    log(`back out landed on src ${back === cityMapSrc ? "== city map ✓" : "(a stored ancestor)"}`);
  });
  await page.waitForTimeout(2500);
  await shot(page, "back-on-city-map");

  // ── 7. GO IN a DIFFERENT landmark (tour — in → out → in) ────────────────────
  let secondSrc = "";
  try {
    const cur = (await img(page).getAttribute("src")) ?? "";
    const other = await landmarkPoint(
      page,
      /palace|drum|tavern|bridge|dock|patrician/i,
      await contentPoint(page, 0.62, 0.5),
    );
    log(`go IN (second): ${other.matched ?? "fallback spot"}`);
    await tapAt(page, other);
    secondSrc = await waitSettled(page, cur, GEN_TIMEOUT);
    await page.waitForTimeout(3500);
    await shot(page, "inside-second-building");
    // step back out again
    await stepOut(page, "root", secondSrc);
    await page.waitForTimeout(2000);
    await shot(page, "back-on-city-again");
  } catch (e) {
    log(`WARN: second-building beat skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 8. AROUND — bloom neighbours / pan the world (tour) ──────────────────────
  try {
    const around = page.getByRole("button", { name: "Around" }).first();
    if ((await around.count()) && (await around.isEnabled())) {
      const cur = (await img(page).getAttribute("src")) ?? "";
      log("AROUND: look around the city");
      await around.click();
      // Around may outpaint the map (new src) or stream a neighbour tray.
      await waitSettled(page, cur, GEN_TIMEOUT).catch(() =>
        log("WARN: around produced no new main image (tray-only or no-op)"),
      );
      await page.waitForTimeout(3000);
      await shot(page, "around-neighbours");
    } else {
      log("WARN: Around button not available");
    }
  } catch (e) {
    log(`WARN: around beat skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 9. OUTWARD — zoom out BEYOND the city (tour) ────────────────────────────
  try {
    const ascend = page.getByRole("button", { name: /zoom out \/ step back/i }).first();
    if ((await ascend.count()) && (await ascend.isEnabled())) {
      const cur = (await img(page).getAttribute("src")) ?? "";
      log("OUTWARD: zoom out to the region that contains Ankh-Morpork");
      await ascend.click();
      await waitSettled(page, cur, GEN_TIMEOUT);
      await page.waitForTimeout(3500);
      await shot(page, "outward-region");
    } else {
      log("WARN: OUTWARD (zoom out / step back) button not available/enabled");
      await shot(page, "outward-unavailable");
    }
  } catch (e) {
    log(`WARN: outward beat skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 10. Atlas finale (tour) ─────────────────────────────────────────────────
  if (session) {
    log("atlas: the session chain");
    await page.goto(`${BASE}/atlas/${session}`, { waitUntil: "load" });
    await page.waitForTimeout(2800);
    const fit = page.getByRole("button", { name: /fit all/i }).first();
    if (await fit.count()) await fit.click().catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, "atlas");
  }

  await page.close();
  await context.close();
  await browser.close();

  const files = await readdir(ARTIFACTS);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no webm produced");
  const webmPath = path.join(ARTIFACTS, webm);
  log(`raw: ${webmPath}`);
  log(`transcoding → ${MP4_OUT}`);
  await run("ffmpeg", [
    "-y", "-i", webmPath,
    "-filter:v", "setpts=0.4*PTS",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "slow",
    "-movflags", "+faststart", "-an",
    MP4_OUT,
  ]);
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
