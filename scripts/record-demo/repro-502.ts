/**
 * 502 / dropped-enter repro harness. Fresh /play session → Ankh map → a loop of
 * building taps. For EACH tap it records: did a generation actually start, did
 * the image settle, and every 4xx/5xx response (with URL + body — the proxy
 * routes return {error,detail} on 502, naming the failing hop + reason).
 *
 *   DEMO_BASE_URL=http://localhost:3000 node_modules/.bin/tsx scripts/record-demo/repro-502.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const ITERS = Number(process.env.REPRO_ITERS ?? 6);
const PER_ENTER_MS = Number(process.env.REPRO_PER_ENTER_MS ?? 100_000);

const QUERY =
  "A detailed top-down fantasy city map of Ankh-Morpork: the Unseen University " +
  "with its tall Tower of Art, the Patrician's Palace, the Brass Bridge over the " +
  "slow brown River Ankh, the Mended Drum tavern, the Shades' crooked alleys, and " +
  "wooden docks along the riverbank — each landmark clearly labelled, aged parchment.";

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m: string) => console.log(`[repro ${ts()}] ${m}`);
const img = (p: Page) => p.locator('img[alt^="Generated illustration"]').first();

const SPOTS = [
  { name: "tower (top-left)", x: 0.16, y: 0.34 },
  { name: "palace (right)", x: 0.66, y: 0.42 },
  { name: "bridge (center)", x: 0.5, y: 0.52 },
  { name: "docks (bottom)", x: 0.42, y: 0.8 },
  { name: "shades (lower-right)", x: 0.74, y: 0.66 },
  { name: "drum (mid-left)", x: 0.26, y: 0.6 },
];

async function contentPoint(page: Page, xFrac: number, yFrac: number) {
  const pt = await page.evaluate(
    ([fx, fy]) => {
      const el = document.querySelector('img[alt^="Generated illustration"]') as HTMLImageElement | null;
      if (!el || !el.naturalWidth || !el.naturalHeight) return null;
      const r = el.getBoundingClientRect();
      const na = el.naturalWidth / el.naturalHeight;
      const ba = r.width / r.height;
      let w = r.width, h = r.height, ox = 0, oy = 0;
      if (na > ba) { h = r.width / na; oy = (r.height - h) / 2; }
      else { w = r.height * na; ox = (r.width - w) / 2; }
      return { x: r.left + ox + w * (fx as number), y: r.top + oy + h * (fy as number) };
    },
    [xFrac, yFrac],
  );
  if (!pt) throw new Error("no image content rect");
  return pt;
}

async function settle(page: Page, prev: string, timeout: number): Promise<string> {
  const end = Date.now() + timeout;
  let last = "", since = 0;
  while (Date.now() < end) {
    const src = (await img(page).getAttribute("src")) ?? "";
    const gen = await page.getByTestId("generating-banner").count();
    if (src && src !== prev && gen === 0) {
      if (src === last) { if (Date.now() - since >= 1500) return src; }
      else { last = src; since = Date.now(); }
    } else last = "";
    await page.waitForTimeout(500);
  }
  return "";
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  let n502 = 0, nFail = 0, nDropped = 0, nNeverSettled = 0;
  page.on("response", async (r) => {
    const s = r.status();
    if (s >= 400 && s !== 404 && s !== 499) {
      let body = "";
      try { body = (await r.text()).slice(0, 400).replace(/\s+/g, " "); } catch { body = "<no body>"; }
      if (s === 502) n502++;
      log(`⚠️  RESP ${s} ${r.request().method()} ${r.url().replace(BASE, "")}  body=${body}`);
    }
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED/.test(err)) { nFail++; log(`❌ REQFAIL ${r.method()} ${r.url().replace(BASE, "")}  ${err}`); }
  });
  page.on("console", (m) => { if (m.type() === "error" && !/theme-init|404/.test(m.text())) log(`console.error: ${m.text().slice(0, 200)}`); });

  // ── boot the map ──
  log(`opening ${BASE}/play`);
  await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Vintage" }).first().click({ timeout: 10_000 }).catch(() => {});
  const world = page.getByRole("button", { name: "world" }).first();
  if ((await world.count()) && (await world.getAttribute("aria-pressed")) !== "true") await world.click();
  await page.waitForTimeout(500);
  log("submitting Ankh-Morpork query");
  const tb = page.getByRole("textbox").first();
  await tb.click(); await tb.fill(QUERY); await page.waitForTimeout(400);
  const go = page.getByRole("button", { name: "Go" }).first();
  for (let i = 0; i < 30 && !(await go.isEnabled()); i++) await page.waitForTimeout(500);
  await go.click();
  const mapSrc = await settle(page, "", 180_000);
  if (!mapSrc) throw new Error("map never rendered");
  log("map rendered");
  await page.waitForTimeout(2500);

  const genStarted = () =>
    page.getByText(/Resolving|Exploring|Planning|Drawing|Generating|Looking|subject/i)
      .first().waitFor({ state: "visible", timeout: 9000 }).then(() => true).catch(() => false);

  for (let i = 0; i < ITERS; i++) {
    // reset to the root map via breadcrumb (stored load) so every tap is a fresh enter
    const rootCrumb = page.locator('[data-testid="breadcrumb"] button').first();
    if (await rootCrumb.count()) { await rootCrumb.click().catch(() => {}); await page.waitForTimeout(2500); }
    const spot = SPOTS[i % SPOTS.length]!;
    const prev = (await img(page).getAttribute("src")) ?? "";
    log(`── iter ${i + 1}/${ITERS}: tap ${spot.name} ──`);
    const pt = await contentPoint(page, spot.x, spot.y);
    const tapStart = Date.now();
    await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.up();
    const fired = await genStarted();
    if (!fired) nDropped++;
    log(`   tap ${fired ? "FIRED a generation" : "⚠️ DROPPED (no gen started)"}`);
    const out = await settle(page, prev, PER_ENTER_MS);
    const took = ((Date.now() - tapStart) / 1000).toFixed(1);
    if (out) log(`   ✓ entered in ${took}s`);
    else { nNeverSettled++; log(`   ✗ NEVER SETTLED after ${took}s`); }
    await page.waitForTimeout(1500);
  }

  log(`════ done over ${ITERS} enters: ${n502}×502, ${nDropped} dropped taps, ${nNeverSettled} never-settled, ${nFail} non-abort reqfails ════`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
