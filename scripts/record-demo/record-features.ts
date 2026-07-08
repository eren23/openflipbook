/**
 * Feature studies — one self-contained, recorded walkthrough per shipped
 * feature. Each `Study` drives the REAL app (real Playwright mouse, real
 * generations) and sequences on real signals (image-stable, node-changed,
 * DOM markers) — never sleeps-as-truth or img-src hacks. Every study records
 * its own video so the clip can be audited before anyone trusts it (the
 * "error-infested video" lesson, PR #129).
 *
 * Extend it: add one entry to STUDIES. That's the whole contract.
 *
 * Recording only produces raw WebM (Playwright native — no shelling out). The
 * sibling `encode-studies.sh` transcodes each to MP4 + dumps 1 fps audit frames.
 *
 * Run against a stack (web on :3001 when jobforge holds :3000):
 *   DEMO_BASE_URL=http://localhost:3001 pnpm tsx record-features.ts
 *   DEMO_BASE_URL=http://localhost:3001 pnpm tsx record-features.ts wander   # one study
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "studies");
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3001";
const VIEWPORT = { width: 1280, height: 800 };
const GEN_TIMEOUT = 150_000;

// ── shared helpers, passed to every study ───────────────────────────────────
interface H {
  base: string;
  img: (p: Page) => ReturnType<Page["locator"]>;
  waitStable: (p: Page, timeout?: number) => Promise<string>;
  hover: (p: Page, xPct: number, yPct: number) => Promise<void>;
  tap: (p: Page, xPct: number, yPct: number) => Promise<void>;
  caption: (p: Page, text: string) => Promise<void>;
  seed: (p: Page, query: string, opts?: { world?: boolean; style?: string }) => Promise<void>;
  node: (p: Page) => string;
  waitNodeChange: (p: Page, from: string, timeout: number) => Promise<string>;
}

const imgLoc = (p: Page) => p.locator('img[alt^="Generated illustration"]').first();

const h: H = {
  base: BASE,
  img: imgLoc,
  // TRUE ready, not just a stable draft: the progressive draft paints first and
  // its src stabilises for 2.5s BEFORE the final lands — but the page's phase is
  // still "generating" then, so the prefetch (nudge) and Wander guards haven't
  // armed. Wait for the "…full render is refining…" draft status to clear FIRST,
  // then confirm the image is stable. (No draft on the fast tier → clears
  // immediately.) This is the fix for all three studies operating on a draft.
  async waitStable(p, timeout = GEN_TIMEOUT) {
    await imgLoc(p).waitFor({ state: "visible", timeout });
    const end = Date.now() + timeout;
    const refining = p.getByText("refining", { exact: false });
    while (Date.now() < end) {
      if ((await refining.count().catch(() => 0)) === 0) break; // final settled
      await p.waitForTimeout(600);
    }
    let last = "";
    let since = 0;
    while (Date.now() < end) {
      const src = (await imgLoc(p).getAttribute("src")) ?? "";
      if (src && src === last) {
        if (Date.now() - since >= 2500) return src;
      } else {
        last = src;
        since = Date.now();
      }
      await p.waitForTimeout(500);
    }
    throw new Error("image never stabilized");
  },
  async hover(p, xPct, yPct) {
    const box = await imgLoc(p).boundingBox();
    if (!box) throw new Error("no image box");
    await p.mouse.move(box.x + box.width * xPct, box.y + box.height * yPct, { steps: 6 });
  },
  async tap(p, xPct, yPct) {
    const box = await imgLoc(p).boundingBox();
    if (!box) throw new Error("no image box");
    await p.mouse.move(box.x + box.width * xPct, box.y + box.height * yPct, { steps: 4 });
    await p.mouse.down();
    await p.mouse.up();
  },
  // A fixed caption banner so the clip is self-documenting. Re-inject after any
  // navigation (it lives in the DOM, which a nav clears).
  async caption(p, text) {
    await p.evaluate((t) => {
      let el = document.getElementById("__study_caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "__study_caption";
        el.style.cssText =
          "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99999;" +
          "background:rgba(17,17,17,.82);color:#fff;font:600 15px/1.3 ui-sans-serif,system-ui;" +
          "padding:8px 16px;border-radius:9999px;box-shadow:0 4px 16px rgba(0,0,0,.3);" +
          "backdrop-filter:blur(4px);pointer-events:none;max-width:80vw;text-align:center;";
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  },
  // Land on /play, (optionally) turn World Mode off, pick a style, type the
  // query, submit, and wait for the first page to settle.
  async seed(p, query, opts = {}) {
    await p.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
    await p.getByRole("textbox").first().waitFor({ timeout: 30_000 });
    await p.waitForTimeout(1000);
    if (opts.world === false) {
      const world = p.getByRole("button", { name: "world", exact: true });
      if ((await world.getAttribute("aria-pressed")) === "true") await world.click().catch(() => {});
    }
    if (opts.style) await p.getByRole("button", { name: opts.style }).click().catch(() => {});
    await p.waitForTimeout(300);
    await p.getByRole("textbox").first().fill(query);
    await p.keyboard.press("Enter");
    await this.waitStable(p);
  },
  node(p) {
    const m = /\/n\/([0-9a-f-]+)/.exec(p.url());
    return m ? m[1]! : "";
  },
  async waitNodeChange(p, from, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const n = this.node(p);
      if (n && n !== from) return n;
      await p.waitForTimeout(1000);
    }
    throw new Error("node never changed");
  },
};

// ── the studies ─────────────────────────────────────────────────────────────
interface Study {
  name: string;
  run: (p: Page, h: H) => Promise<void>;
}

const smarterTaps: Study = {
  name: "smarter-taps",
  async run(p, h) {
    // A mostly-empty page so several spots are genuinely blank. Whether the
    // resolver flags a given spot empty is stochastic (~2/3 on the default
    // model), so we PROBE candidates and demo the one it confirms empty —
    // deterministic, not hoping a fixed corner happens to be blank.
    await h.seed(p, "a single detailed compass rose in the exact CENTER of a large sheet of aged parchment, with wide, completely empty blank margins on all sides", {
      world: false,
      style: "Vintage",
    });
    await h.caption(p, "Smarter taps · finding a spot the resolver calls empty");
    await p.waitForTimeout(1000);
    // Probe the MARGINS (blank); the compass sits in the centre (content).
    const candidates: [number, number][] = [
      [0.1, 0.12], [0.9, 0.12], [0.1, 0.88], [0.9, 0.88], [0.5, 0.08], [0.5, 0.92],
    ];
    let blank: [number, number] | null = null;
    for (const [x, y] of candidates) {
      await h.hover(p, x, y); // real hover → warms the prefetch resolve
      const resp = await p
        .waitForResponse((r) => r.url().includes("/resolve-click"), { timeout: 13000 })
        .catch(() => null);
      const j = resp ? await resp.json().catch(() => null) : null;
      if (j && j.groundable === false) {
        blank = [x, y];
        break;
      }
    }
    if (blank) {
      await h.caption(p, "Empty spot → a gentle nudge, no page generated");
      await p.waitForTimeout(600);
      await h.tap(p, blank[0], blank[1]); // → "nothing to explore here"
      await p.waitForTimeout(2600); // hold on the nudge
    } else {
      await h.caption(p, "(no spot resolved empty this run)");
      await p.waitForTimeout(1500);
    }
    await h.caption(p, "A real feature does generate a page");
    await p.waitForTimeout(600);
    const before = h.node(p);
    await h.tap(p, 0.5, 0.5); // a content spot → generates a child
    await h.waitNodeChange(p, before, GEN_TIMEOUT).catch(() => {});
    await h.waitStable(p);
    await p.waitForTimeout(1500);
  },
};

const zoomIntoTap: Study = {
  name: "zoom-into-tap",
  async run(p, h) {
    await h.seed(p, "a colorful treasure map of a pirate island with a big skull rock", {
      world: false,
      style: "Storybook",
    });
    await h.caption(p, "Zoom into the tapped point while the next page loads");
    await p.waitForTimeout(1200);
    // The zoom plays in the ~5s AFTER the tap, before the draft — hold on it.
    const before = h.node(p);
    await h.tap(p, 0.5, 0.42);
    await p.waitForTimeout(5200); // capture the push-in toward the tap
    await h.waitNodeChange(p, before, GEN_TIMEOUT).catch(() => {});
    await h.waitStable(p);
    await p.waitForTimeout(1500);
  },
};

const wander: Study = {
  name: "wander",
  async run(p, h) {
    // Wander in World Mode (the demo default) — the path verified by hand.
    await h.seed(p, "a bustling medieval fantasy city map with many labelled districts", {
      style: "Vintage",
    });
    await h.caption(p, "Wander · the world explores itself, hands-free");
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /Wander/ }).click();
    await p.waitForTimeout(600);
    await h.caption(p, "Wandering… auto-tapping the most interesting spot each page");
    // Two hands-free hops.
    let cur = h.node(p);
    for (let i = 0; i < 2; i++) {
      cur = await h.waitNodeChange(p, cur, GEN_TIMEOUT);
      await h.waitStable(p);
      await p.waitForTimeout(1200);
    }
    await h.caption(p, "Tap Wander again to take back control");
    await p.getByRole("button", { name: /Wandering/ }).click().catch(() => {});
    await p.waitForTimeout(1800);
  },
};

const STUDIES: Study[] = [smarterTaps, zoomIntoTap, wander];

// ── driver: record each study to studies/raw/<name>/*.webm ───────────────────
async function record(study: Study): Promise<boolean> {
  const raw = path.join(OUT, "raw", study.name);
  await rm(raw, { recursive: true, force: true });
  await mkdir(raw, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: raw, size: VIEWPORT },
  });
  const page = await context.newPage();
  const errs: string[] = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  console.log(`\n[${study.name}] recording…`);
  let ok = true;
  try {
    await study.run(page, h);
  } catch (e) {
    ok = false;
    console.error(`[${study.name}] FAILED: ${(e as Error).message}`);
  } finally {
    await context.close(); // flushes the video
    await browser.close();
  }
  if (errs.length) console.warn(`[${study.name}] ${errs.length} console error(s): ${errs.slice(0, 3).join(" | ")}`);
  await writeFile(path.join(raw, "console-errors.json"), JSON.stringify(errs, null, 2));
  console.log(`[${study.name}] raw → ${path.relative(HERE, raw)}  (ok=${ok})`);
  return ok;
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const studies = only ? STUDIES.filter((s) => s.name === only) : STUDIES;
  if (!studies.length) throw new Error(`no study "${only}". Have: ${STUDIES.map((s) => s.name).join(", ")}`);
  await mkdir(OUT, { recursive: true });
  const results: Record<string, boolean> = {};
  for (const s of studies) results[s.name] = await record(s);
  console.log(`\nRaw captures done. Encode with ./encode-studies.sh`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
