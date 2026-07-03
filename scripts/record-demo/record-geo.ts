/**
 * Records the geometric-world showcase clip:
 *   world from scratch  →  coordinate overlay (the numeric world)
 *   →  go IN (level down)  →  go IN again (deeper)
 *   →  breadcrumb OUT (levels up)  →  atlas: zoom OUT (the nested chain) + zoom IN.
 *
 * Run against the pro dev server (nano-banana-pro + GEOMETRIC_WORLD flags):
 *   DEMO_BASE_URL=http://localhost:3137 pnpm tsx scripts/record-demo/record-geo.ts
 *
 * Output:
 *   scripts/record-demo/artifacts-geo-vid/*.webm   (raw capture)
 *   scripts/record-demo/geo-demo.mp4               (re-encoded, ~3.3x)
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts-geo-vid");
const MP4_OUT = path.join(HERE, "geo-demo.mp4");

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3137";
const VIEWPORT = { width: 1280, height: 800 };
const GEN_TIMEOUT = 150_000;

const QUERY =
  "A detailed top-down fantasy city map of Ankh-Morpork: the Unseen University with its tall Tower of Art, the Patrician's Palace, the Brass Bridge crossing the River Ankh, the Mended Drum tavern, and the Guild of Thieves — each landmark clearly labelled.";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "inherit" });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
    c.on("error", reject);
  });
}

const img = (p: Page) => p.locator('img[alt^="Generated illustration"]').first();

async function waitStable(page: Page, timeout: number): Promise<string> {
  await img(page).waitFor({ state: "visible", timeout });
  let last = "";
  let since = 0;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const src = (await img(page).getAttribute("src")) ?? "";
    if (src && src === last) {
      if (Date.now() - since >= 2500) return src;
    } else {
      last = src;
      since = Date.now();
    }
    await page.waitForTimeout(500);
  }
  throw new Error("image never stabilized");
}


async function tap(page: Page, xPct: number, yPct: number): Promise<void> {
  const box = await img(page).boundingBox();
  if (!box) throw new Error("no image box");
  await page.mouse.move(box.x + box.width * xPct, box.y + box.height * yPct);
  await page.mouse.down();
  await page.mouse.up();
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

  // ── 1. A world from scratch ────────────────────────────────────────────────
  console.log("[geo] opening play");
  // domcontentloaded, NOT networkidle: /play holds a persistent Mongo
  // change-stream SSE open, so networkidle never fires (the record-ankh
  // lesson) — wait for the query box instead.
  await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Vintage" }).click().catch(() => {});
  await page.waitForTimeout(400);
  const world = page.getByRole("button", { name: "world" }).first();
  if ((await world.count()) && (await world.getAttribute("aria-pressed")) !== "true") {
    await world.click();
  }
  const tb = page.getByRole("textbox").first();
  await tb.click();
  await tb.fill(QUERY);
  await page.waitForTimeout(400);
  console.log("[geo] generating the map");
  await page.getByRole("button", { name: "Go" }).click();
  await waitStable(page, GEN_TIMEOUT);
  await page.waitForTimeout(2500);

  // Session id (for the atlas leg) — the atlas link is persist-gated and can
  // land ~10s after the image stabilizes, so poll long and fall back to the
  // localStorage session key the play page maintains.
  let session: string | null = null;
  for (let i = 0; i < 30 && !session; i++) {
    session = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/atlas/"]');
      const m = (a?.getAttribute("href") ?? "").match(/\/atlas\/(session_[a-z0-9-]+)/i);
      if (m) return m[1];
      const ls = window.localStorage.getItem("openflipbook.lastSession") ?? "";
      const lm = ls.match(/session_[a-z0-9-]+/i);
      return lm ? lm[0] : null;
    });
    if (!session) await page.waitForTimeout(800);
  }
  console.log("[geo] session:", session);

  // ── 2. The numeric world — coordinate overlay + minimap ─────────────────────
  // Extraction (entity boxes/polygons/labels + the enter rings) lands well
  // AFTER the image stabilizes — toggling ⊞ geo early puts an EMPTY overlay
  // on camera (take-2 lesson). Wait for the markers/labels to exist first.
  console.log("[geo] waiting for extraction (rings/labels)");
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("[data-entity-id], [data-label-id]").length >
        0,
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => console.log("[geo] extraction markers never appeared — continuing"));
  console.log("[geo] coordinate overlay");
  const geo = page.getByRole("button", { name: /geo$/ }).first();
  if ((await geo.count()) && (await geo.getAttribute("aria-pressed")) !== "true") {
    await geo.click();
  }
  await page.waitForTimeout(4000); // linger on the populated coords + minimap

  // ── 3. Go IN — level down ───────────────────────────────────────────────────
  // Tap a REAL enterable place: the centre of the first enter-ring marker
  // (falls back to the historical hardcoded point when no ring rendered).
  const ring = await page.evaluate(() => {
    const m = document.querySelector("[data-entity-id]");
    if (!m) return null;
    const r = (m as HTMLElement).getBoundingClientRect();
    const img = document
      .querySelector('img[alt^="Generated illustration"]')
      ?.getBoundingClientRect();
    if (!img || !img.width) return null;
    return {
      x: (r.x + r.width / 2 - img.x) / img.width,
      y: (r.y + r.height / 2 - img.y) / img.height,
    };
  });
  console.log("[geo] go in", ring ? `(ring at ${ring.x.toFixed(2)},${ring.y.toFixed(2)})` : "(fallback point)");
  await tap(page, ring?.x ?? 0.16, ring?.y ?? 0.42);
  // Completion = the trail grew (persist-gated step counter) — NEVER the img
  // src: the progressive draft swaps src long before the final lands (the
  // take-2 bug: we "finished" mid-generation and the entered page never made
  // it on camera).
  await page.waitForFunction(
    () => /step 2 of/.test(document.body.innerText),
    undefined,
    { timeout: GEN_TIMEOUT },
  );
  await waitStable(page, GEN_TIMEOUT);
  await page.waitForTimeout(3500); // linger on the entered place

  // ── 3b. Step back OUT — the spatial breadcrumb takes you home ───────────────
  console.log("[geo] step back out");
  const back = page.getByRole("button", { name: "← back" }).first();
  if (await back.count()) {
    await back.click().catch(() => {});
    await page
      .waitForFunction(
        () => /step 1 of 2/.test(document.body.innerText),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(3000); // linger back on the map (overlay persists)
  }

  // ── 4. Levels up/down + zoom — the atlas nested chain ───────────────────────
  if (session) {
    console.log("[geo] atlas: zoom out to the whole chain");
    await page.goto(`${BASE}/atlas/${session}`, { waitUntil: "load" });
    // Both nodes must be on the board before the zoom choreography — the
    // take-2 atlas showed "1 pages" because the child hadn't persisted yet.
    await page
      .waitForFunction(() => /2 pages/.test(document.body.innerText), undefined, {
        timeout: 30_000,
      })
      .catch(() => console.log("[geo] atlas still shows 1 page — continuing"));
    await page.waitForTimeout(2800);
    const fit = page.getByRole("button", { name: /fit all/i }).first();
    if (await fit.count()) await fit.click().catch(() => {});
    await page.waitForTimeout(3000);
    console.log("[geo] atlas: zoom in on a branch");
    await page.mouse.move(VIEWPORT.width * 0.32, VIEWPORT.height * 0.28);
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, -130);
      await page.waitForTimeout(140);
    }
    await page.waitForTimeout(3000);
    console.log("[geo] atlas: zoom back out");
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 130);
      await page.waitForTimeout(140);
    }
    await page.waitForTimeout(2200);
  }

  await page.close();
  await context.close();
  await browser.close();

  const files = await readdir(ARTIFACTS);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no webm produced");
  const webmPath = path.join(ARTIFACTS, webm);
  console.log(`[geo] raw: ${webmPath}`);

  // Speed up ~3.3x so the long pro generations compress to a watchable clip.
  console.log(`[geo] transcoding → ${MP4_OUT}`);
  await run("ffmpeg", [
    "-y", "-i", webmPath,
    "-filter:v", "setpts=0.3*PTS",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "slow",
    "-movflags", "+faststart", "-an",
    MP4_OUT,
  ]);
  console.log("[geo] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
