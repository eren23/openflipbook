/**
 * Records the Ankh-Morpork editing-era demo:
 *   a richly-described Discworld city map (Describe a place, Vintage style)
 *   →  coordinate overlay (the numeric world)
 *   →  GO IN (the Unseen University)  →  breadcrumb back
 *   →  GO IN (a second landmark)      →  breadcrumb back
 *   →  the geo-aware RIGHT-CLICK menu, on camera
 *   →  drag-select a stretch of the river → "a small wooden ferry boat…"
 *      → the judged inpaint + its verdict chip
 *   →  atlas finale (zoom out over the session chain).
 *
 * Run against a stack with the world + editing flags:
 *   backend: EDIT_REGION=1 EDIT_JUDGE=1 PORT=8787 python local_server.py
 *   web:     NEXT_PUBLIC_EDIT_REGION=true pnpm dev
 *   DEMO_BASE_URL=http://localhost:3000 pnpm tsx scripts/record-demo/record-ankh.ts
 *
 * CORE beats (map render, first enter) fail LOUD with a screenshot + exit 1
 * — never a junk mp4. Tour beats (second enter, menu, edit, atlas) soft-skip
 * with a warning so layout variance can't kill the clip.
 *
 * Output:
 *   scripts/record-demo/artifacts-ankh/*.webm + NN-*.png   (raw, gitignored)
 *   scripts/record-demo/ankh-demo.mp4                      (~2.5x speedup)
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-ankh");
const MP4_OUT = path.join(HERE, "ankh-demo.mp4");

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const VIEWPORT = { width: 1280, height: 800 };
// Judged renders retry (render + critics + one retry), and the mask-edit
// path RE-UPLOADS the full-res source + mask to fal storage every time — on
// a slow link that upload alone ran 3.5 min in testing. 8 minutes per beat.
const GEN_TIMEOUT = Number(process.env.DEMO_GEN_TIMEOUT_MS ?? 480_000);

const QUERY =
  "A detailed top-down fantasy city map of Ankh-Morpork: the Unseen University " +
  "with its tall Tower of Art, the Patrician's Palace, the Brass Bridge crossing " +
  "the slow brown River Ankh, the Mended Drum tavern, the Shades' crooked alleys, " +
  "and wooden docks along the riverbank — each landmark clearly labelled, aged parchment.";

const FERRY_INSTRUCTION = "add a small wooden ferry boat crossing the river";

const log = (msg: string) => console.log(`[ankh] ${msg}`);

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
}

/** A CORE beat: on failure, screenshot + exit 1 — never a junk mp4. */
async function mustHappen(page: Page, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const file = path.join(ARTIFACTS, `FAILED-${what.replace(/\W+/g, "-")}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    console.error(`[ankh] FAILED ${what} — screenshot: ${file}`);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Wait for a generation to COMPLETE: the image src differs from `prev` and
 * the generating banner is gone (the authoritative end — judged loops stream
 * rejected attempts as progress frames, so src stability alone lies), then a
 * short settle. Pass prev="" for the first render. */
async function waitGenerated(page: Page, prev: string, timeout: number): Promise<string> {
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
  throw new Error("generation never completed (banner still up or src unchanged)");
}

/** Viewport point for a landmark: the geometry overlay's box when a label
 * matches (the entity's REAL detected coordinates), else the fallback —
 * already a VIEWPORT point (use contentPoint for letterbox-safe fractions). */
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

/** Viewport point for a fraction of the image CONTENT — the letterboxed
 * rectangle the pixels actually occupy under object-fit: contain — not the
 * element box. A squarer-than-16:9 render pillarboxes, and element-relative
 * fractions would land clicks in the margins (normalizeClickOnImage rejects
 * those, and right-clicks there lose their geo items). */
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

/** Wait for the geometry overlay's entity boxes (extraction lands ~10-20s
 * after a page persists). Times out quietly — the fallback spot still works. */
async function waitForGeoBoxes(page: Page, timeout: number): Promise<void> {
  await page
    .locator('[data-testid="geo-box"]')
    .first()
    .waitFor({ state: "visible", timeout })
    .catch(() => log("WARN: no geo boxes appeared (extraction still pending?)"));
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
  await page.goto(`${BASE}/play`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // The style lock matters (it pins the medium for every page) — assert it.
  await mustHappen(page, "style-lock", () =>
    page.getByRole("button", { name: "Vintage" }).first().click({ timeout: 10_000 }),
  );
  await page.waitForTimeout(500);
  const world = page.getByRole("button", { name: "world" }).first();
  if ((await world.count()) && (await world.getAttribute("aria-pressed")) !== "true") {
    await world.click();
  }
  await page.waitForTimeout(500);

  // ── 2. The map (CORE) ───────────────────────────────────────────────────────
  // Plain Go, NOT "Describe a place": the describe flow auto-chains follow-on
  // pages, which yanks the trail out from under a scripted tour (take 2's
  // back-navigation walked onto auto-created pages).
  log("describing Ankh-Morpork");
  const tb = page.getByRole("textbox").first();
  const go = page.getByRole("button", { name: "Go" }).first();
  // Submit, and CONFIRM generation actually started (the banner appears).
  // A lazy-compiling dev server or a bursty network can swallow the first
  // click after a fresh boot — re-fill + re-click until the banner shows.
  const submitQuery = async (): Promise<boolean> => {
    await tb.click();
    await tb.fill(QUERY);
    await page.waitForTimeout(400);
    // Go is disabled until the controlled input's onChange lands in React
    // state — wait for it rather than racing hydration.
    await go.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 30; i++) {
      if (await go.isEnabled()) break;
      await page.waitForTimeout(500);
    }
    await go.click();
    // Generation started iff the page enters its generating state. NOTE the
    // first render has no banner (that's an OVERLAY over an existing image) —
    // it shows the planner status in the empty-state placeholder. Match the
    // status TEXT, which is present in both cases.
    return page
      .getByText(/Resolving|Exploring|Planning page|Drawing|Generating/i)
      .first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
  };
  let mapSrc = "";
  await mustHappen(page, "map-render", async () => {
    let started = await submitQuery();
    if (!started) {
      log("WARN: generation did not start on first submit — retrying");
      started = await submitQuery();
    }
    if (!started) throw new Error("generation never started after the query submit");
    mapSrc = await waitGenerated(page, "", GEN_TIMEOUT);
  });
  await page.waitForTimeout(2500);
  await shot(page, "map");

  // Session id for the atlas finale. The link is persist-gated (the node
  // takes ~7-9s to land in Mongo/R2), so poll generously — this wait also
  // gives extraction time to localize entities for the menu beat.
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

  // ── 3. The numeric world ────────────────────────────────────────────────────
  log("coordinate overlay");
  const geo = page.getByRole("button", { name: /geo$/ }).first();
  if ((await geo.count()) && (await geo.getAttribute("aria-pressed")) !== "true") {
    await geo.click();
  }
  await waitForGeoBoxes(page, 25_000); // boxes render once the overlay is on
  await page.waitForTimeout(4000);
  await shot(page, "geo-overlay");

  // ── 4. The geo-aware right-click menu, on camera (tour) ────────────────────
  // Editing beats run FIRST, on the freshly rendered map — no back-navigation
  // anywhere in the critical path (the lesson of takes 1+2).
  try {
    log("right-click menu");
    const pt = await landmarkPoint(page, /universit|tower|palace/i, await contentPoint(page, 0.2, 0.4));
    await page.mouse.click(pt.x, pt.y, { button: "right" });
    await page.waitForTimeout(2800); // linger on the target-aware items
    await shot(page, "context-menu");
    // Backdrop click closes — aim TOP-RIGHT: the bottom-left corner hosts the
    // Next dev-tools badge, which eats clicks and leaves the backdrop up.
    await page.mouse.click(VIEWPORT.width - 30, 90);
    await page.waitForTimeout(800);
  } catch (e) {
    log(`WARN: context-menu beat skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 5. The ferry — drag-select the river, judged inpaint (tour) ─────────────
  try {
    log("edit mode: drag a region over the river");
    await page.getByRole("button", { name: /Edit$/ }).first().click({ timeout: 10_000 });
    // Edit mode is armed when its instruction box renders.
    await page
      .getByPlaceholder(/describe how to change/i)
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(500);
    // A low-mid stretch of the CONTENT — the river band in these renders.
    // The drag must VERIFIABLY take (take 5 submitted maskless after a drag
    // silently failed to register): check the marquee, retry once.
    const dragRegion = async () => {
      const from = await contentPoint(page, 0.38, 0.55);
      const to = await contentPoint(page, 0.64, 0.75);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(
          from.x + ((to.x - from.x) * i) / 8,
          from.y + ((to.y - from.y) * i) / 8,
        );
        await page.waitForTimeout(60);
      }
      await page.mouse.up();
      await page.waitForTimeout(1000);
      return (await page.getByTestId("region-marquee").count()) > 0;
    };
    let selected = await dragRegion();
    if (!selected) {
      log("WARN: drag did not register a selection — retrying once");
      selected = await dragRegion();
    }
    if (!selected) {
      throw new Error("selection never registered — refusing a maskless submit");
    }
    await shot(page, "region-selected");
    log("typing the ferry instruction");
    const editBox = page.getByPlaceholder(/describe how to change/i).first();
    await editBox.fill(FERRY_INSTRUCTION);
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Apply" }).first().click();
    mapSrc = await waitGenerated(page, mapSrc, GEN_TIMEOUT);
    await page.waitForTimeout(5000); // linger on the verdict chip
    await shot(page, "ferry-verdict");
  } catch (e) {
    log(`WARN: ferry edit skipped (${e instanceof Error ? e.message : e})`);
    await page.keyboard.press("Escape").catch(() => {});
  }

  // ── 6. Enter the Unseen University (CORE, one network retry) ────────────────
  const uni = await landmarkPoint(page, /universit|tower/i, await contentPoint(page, 0.16, 0.35));
  log(`go in: ${uni.matched ?? "fallback spot (no matching geo-box)"}`);
  await tapAt(page, uni);
  let insideSrc = "";
  await mustHappen(page, "enter-render", async () => {
    try {
      insideSrc = await waitGenerated(page, mapSrc, GEN_TIMEOUT);
    } catch (e) {
      // Hotspot-grade networks drop fal calls in bursts ("network error"
      // banner) — one re-tap is honest resilience, not flake-hiding.
      log(`enter failed once (${e instanceof Error ? e.message : e}) — re-tapping`);
      await tapAt(page, uni);
      insideSrc = await waitGenerated(page, mapSrc, GEN_TIMEOUT);
    }
  });
  await page.waitForTimeout(4000);
  await shot(page, "inside-university");

  // ── 7. Once more, deeper (tour) — from wherever the enter landed ────────────
  try {
    const deeper = await landmarkPoint(page, /drum|tavern|palace|bridge|hall|court/i, await contentPoint(page, 0.55, 0.55));
    log(`go deeper: ${deeper.matched ?? "fallback spot"}`);
    await tapAt(page, deeper);
    await waitGenerated(page, insideSrc, GEN_TIMEOUT);
    await page.waitForTimeout(4000);
    await shot(page, "deeper");
  } catch (e) {
    log(`WARN: deeper enter skipped (${e instanceof Error ? e.message : e})`);
  }

  // ── 8. Atlas finale (tour) ──────────────────────────────────────────────────
  if (session) {
    log("atlas: the session chain");
    await page.goto(`${BASE}/atlas/${session}`, { waitUntil: "load" });
    await page.waitForTimeout(2800);
    const fit = page.getByRole("button", { name: /fit all/i }).first();
    if (await fit.count()) await fit.click().catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, "atlas");
    await page.mouse.move(VIEWPORT.width * 0.4, VIEWPORT.height * 0.4);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -130);
      await page.waitForTimeout(140);
    }
    await page.waitForTimeout(2500);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 130);
      await page.waitForTimeout(140);
    }
    await page.waitForTimeout(2000);
  }

  await page.close();
  await context.close();
  await browser.close();

  const files = await readdir(ARTIFACTS);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no webm produced");
  const webmPath = path.join(ARTIFACTS, webm);
  log(`raw: ${webmPath}`);

  // ~2.5x — slower than the geo clip so the editing beats stay readable.
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
